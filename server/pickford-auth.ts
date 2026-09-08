import {
  buildAuthorizationUrl,
  createPkcePair,
  createState,
  exchangeAuthorizationCode,
  refreshAccessToken,
  registerClient,
  revokeRefreshToken,
  statesMatch,
  type RegisteredClient,
  type TokenSet,
} from './oauth-client.js';
import {
  discoverAuthorizationServer,
  discoverProtectedResource,
  resourceMetadataFromChallenge,
  type AuthorizationServerMetadata,
  type FetchLike,
} from './oauth-discovery.js';
import {
  accessTokenExpired,
  authStatus,
  clearStoredAuth,
  readStoredAuth,
  writeStoredAuth,
  type AuthStatus,
  type StoredAuth,
} from './oauth-store.js';
import { readPrivateJson, removePrivateJson, writePrivateJson } from './private-store.js';
import type { PickfordEnvironment } from './pickford-environment.js';

/**
 * "Sign in with Pickford" for the local renderer: the worker is the OAuth client, the browser only
 * follows the authorization URL and lands back on the worker's own loopback redirect. Access and
 * refresh tokens stay in `.renderer/auth.json` and never reach the page.
 */

export const CLIENT_FILE = 'oauth-client.json';
export const CALLBACK_PATH = '/auth/pickford/callback';

const PENDING_TTL_MS = 10 * 60 * 1000;
const CLIENT_NAME = 'Pickford video renderer (local)';
const SOFTWARE_ID = 'pickford-video-renderer';

interface StoredClient {
  issuer: string;
  clientId: string;
  redirectUris: string[];
  /** A client registered for one scope cannot request another, so it is part of the cache key. */
  scope: string;
  registeredAt: number;
}

interface PendingSignIn {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  resource: string;
  scope: string;
  metadata: AuthorizationServerMetadata;
  createdAt: number;
}

export interface PickfordIdentity {
  userId: string | null;
  role: string | null;
  email: string | null;
}

/**
 * Whoami. `POST /bff/v1/session` accepts the OAuth bearer directly and answers
 * `{user_id, role, csrf_token: null}` without setting a cookie, so it is the account lookup for a
 * bearer client. The email is a display nicety only, fetched best-effort from Identity afterwards.
 */
export async function fetchPickfordIdentity(options: {
  bffBaseUrl: string;
  apiBaseUrl?: string;
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<PickfordIdentity> {
  const response = await options.fetchImpl(`${options.bffBaseUrl}/bff/v1/session`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(response.status === 403
      ? 'This Pickford account does not have the creator role yet. Ask a Pickford admin to grant it.'
      : `Could not read the signed-in Pickford account (HTTP ${response.status}).`);
  }
  const body = await response.json() as { user_id?: unknown; role?: unknown };
  const identity: PickfordIdentity = {
    userId: typeof body.user_id === 'string' ? body.user_id : null,
    role: typeof body.role === 'string' ? body.role : null,
    email: null,
  };
  if (!options.apiBaseUrl) return identity;
  try {
    const account = await options.fetchImpl(`${options.apiBaseUrl}/auth/get_user`, {
      headers: { Authorization: `Bearer ${options.accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!account.ok) {
      await account.body?.cancel().catch(() => undefined);
      return identity;
    }
    const value = await account.json() as { email?: unknown };
    return { ...identity, email: typeof value.email === 'string' ? value.email : null };
  } catch {
    return identity;
  }
}

export class PickfordAuth {
  private readonly pending = new Map<string, PendingSignIn>();
  private refreshing: Promise<StoredAuth> | null = null;
  private identityNotice: string | null = null;

  constructor(private readonly options: {
    environment: PickfordEnvironment;
    fetchImpl?: FetchLike;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    version?: string;
  }) {}

  private get fetchImpl(): FetchLike {
    return this.options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  status(): AuthStatus {
    return authStatus(readStoredAuth(this.options.env));
  }

  signedIn(): boolean {
    return readStoredAuth(this.options.env) !== null;
  }

  private async authorizationServer(resource: string): Promise<{ metadata: AuthorizationServerMetadata; resource: string; scope: string }> {
    // Prefer the challenge the resource itself advertises; fall back to well-known probing.
    let challengeMetadataUrl: string | null = null;
    try {
      const probe = await this.fetchImpl(resource, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      challengeMetadataUrl = resourceMetadataFromChallenge(probe.headers.get('www-authenticate'));
      await probe.body?.cancel().catch(() => undefined);
    } catch {
      challengeMetadataUrl = null;
    }
    const protectedResource = await discoverProtectedResource(
      resource,
      this.fetchImpl,
      challengeMetadataUrl ? [challengeMetadataUrl] : [],
    );
    const metadata = await discoverAuthorizationServer(protectedResource.authorizationServers[0], this.fetchImpl);
    // Resource and scope are a fixed pair. Trust the resource's own metadata over our default when
    // it advertises exactly one scope, so a renamed scope does not need a renderer release.
    const configured = this.options.environment.oauthScope;
    const advertised = protectedResource.scopesSupported;
    const scope = advertised.length && !advertised.includes(configured) && advertised.length === 1
      ? advertised[0]
      : configured;
    return { metadata, resource: protectedResource.resource, scope };
  }

  private storedClient(issuer: string, redirectUri: string, scope: string): StoredClient | null {
    const value = readPrivateJson<StoredClient>(CLIENT_FILE, this.options.env);
    if (!value || value.issuer !== issuer || value.scope !== scope || !Array.isArray(value.redirectUris)) return null;
    return value.redirectUris.includes(redirectUri) ? value : null;
  }

  /** Step 1: register (once per issuer + redirect URI) and hand the browser an authorization URL. */
  async beginSignIn(redirectUri: string): Promise<{ authorizationUrl: string; state: string }> {
    const { metadata, resource, scope } = await this.authorizationServer(this.options.environment.oauthResource);
    let client: StoredClient | RegisteredClient | null = this.storedClient(metadata.issuer, redirectUri, scope);
    if (!client) {
      const registered = await registerClient({
        metadata,
        redirectUris: [redirectUri],
        clientName: CLIENT_NAME,
        scope,
        softwareId: SOFTWARE_ID,
        softwareVersion: this.options.version,
        fetchImpl: this.fetchImpl,
      });
      const stored: StoredClient = {
        issuer: metadata.issuer,
        clientId: registered.clientId,
        redirectUris: registered.redirectUris,
        scope,
        registeredAt: registered.registeredAt,
      };
      writePrivateJson(CLIENT_FILE, stored, this.options.env);
      client = stored;
    }
    const pkce = createPkcePair();
    const state = createState();
    const createdAt = this.now();
    for (const [key, value] of this.pending) if (createdAt - value.createdAt > PENDING_TTL_MS) this.pending.delete(key);
    this.pending.set(state, {
      state, codeVerifier: pkce.codeVerifier, redirectUri, clientId: client.clientId, resource, scope, metadata, createdAt,
    });
    return {
      authorizationUrl: buildAuthorizationUrl({
        metadata, clientId: client.clientId, redirectUri, resource, scope, state, codeChallenge: pkce.codeChallenge,
      }),
      state,
    };
  }

  /** Step 2: the loopback redirect came back. Exchange the code and persist the token set. */
  async completeSignIn(input: { state: string; code: string }): Promise<AuthStatus> {
    const key = [...this.pending.keys()].find(candidate => statesMatch(candidate, input.state));
    const pending = key ? this.pending.get(key) : undefined;
    if (!pending || !key) throw new Error('This sign-in link has expired. Start the sign-in again from the player.');
    this.pending.delete(key);
    if (this.now() - pending.createdAt > PENDING_TTL_MS) {
      throw new Error('This sign-in link has expired. Start the sign-in again from the player.');
    }
    const tokens = await exchangeAuthorizationCode({
      metadata: pending.metadata,
      clientId: pending.clientId,
      code: input.code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
      resource: pending.resource,
      scope: pending.scope,
      fetchImpl: this.fetchImpl,
      now: this.now(),
    });
    const auth = this.persist({
      environment: this.options.environment.name,
      resource: pending.resource,
      issuer: pending.metadata.issuer,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      signedInAt: this.now(),
    }, tokens);
    await this.attachIdentity(auth);
    return this.status();
  }

  private persist(base: Omit<StoredAuth, 'accessToken' | 'refreshToken' | 'scope' | 'expiresAt'>, tokens: TokenSet): StoredAuth {
    const auth: StoredAuth = { ...base, ...tokens };
    writeStoredAuth(auth, this.options.env);
    return auth;
  }

  /** Best-effort: naming the account never gates the rest of the flow. */
  private async attachIdentity(auth: StoredAuth): Promise<void> {
    try {
      const identity = await fetchPickfordIdentity({
        bffBaseUrl: this.options.environment.webBaseUrl,
        apiBaseUrl: this.options.environment.apiBaseUrl,
        accessToken: auth.accessToken,
        fetchImpl: this.fetchImpl,
      });
      this.identityNotice = null;
      writeStoredAuth({ ...auth, email: identity.email, userId: identity.userId, role: identity.role }, this.options.env);
    } catch (error) {
      // A whoami failure must not undo a valid sign-in. It is kept as a notice instead, so a
      // missing creator role is visible right away rather than on the first StoryBundle call.
      this.identityNotice = error instanceof Error ? error.message : null;
    }
  }

  /** A bounded, credential-free explanation of why the account could not be named, if any. */
  notice(): string | null {
    return this.signedIn() ? this.identityNotice : null;
  }

  /** The stored user id, when the whoami answered. Used to scope the fallback bundle listing. */
  userId(): string | null {
    return readStoredAuth(this.options.env)?.userId ?? null;
  }

  /** A valid access token, refreshing (once, serialized) when the stored one is near expiry. */
  async accessToken(): Promise<string> {
    const auth = readStoredAuth(this.options.env);
    if (!auth) throw new Error('Sign in with Pickford before using this renderer.');
    if (!accessTokenExpired(auth, this.now())) return auth.accessToken;
    this.refreshing ??= this.refresh(auth).finally(() => { this.refreshing = null; });
    return (await this.refreshing).accessToken;
  }

  private async refresh(auth: StoredAuth): Promise<StoredAuth> {
    const metadata = await discoverAuthorizationServer(auth.issuer, this.fetchImpl);
    let tokens: TokenSet;
    try {
      tokens = await refreshAccessToken({
        metadata,
        clientId: auth.clientId,
        refreshToken: auth.refreshToken,
        resource: auth.resource,
        scope: auth.scope,
        fetchImpl: this.fetchImpl,
        now: this.now(),
      });
    } catch (error) {
      // Refresh tokens are single-use: replaying one revokes the grant. So this is attempted once
      // and never retried with the same token, and a rejection discards the stored sign-in.
      clearStoredAuth(this.options.env);
      throw new Error(`${error instanceof Error ? error.message : 'The Pickford sign-in expired.'} Sign in with Pickford again.`);
    }
    return this.persist({
      environment: auth.environment,
      resource: auth.resource,
      issuer: auth.issuer,
      clientId: auth.clientId,
      redirectUri: auth.redirectUri,
      signedInAt: auth.signedInAt,
      email: auth.email ?? null,
      userId: auth.userId ?? null,
      role: auth.role ?? null,
    }, tokens);
  }

  async signOut(): Promise<void> {
    const auth = readStoredAuth(this.options.env);
    this.pending.clear();
    this.identityNotice = null;
    clearStoredAuth(this.options.env);
    if (!auth) return;
    try {
      const metadata = await discoverAuthorizationServer(auth.issuer, this.fetchImpl);
      await revokeRefreshToken({ metadata, clientId: auth.clientId, refreshToken: auth.refreshToken, fetchImpl: this.fetchImpl });
    } catch {
      // Local tokens are already gone; a failed revocation must not leave the creator signed in.
    }
  }

  /** Forget the dynamic client registration too. Used by `npm run auth -- logout --forget-client`. */
  forgetClient(): void {
    removePrivateJson(CLIENT_FILE, this.options.env);
  }
}
