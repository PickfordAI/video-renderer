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
  registeredAt: number;
}

interface PendingSignIn {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  resource: string;
  metadata: AuthorizationServerMetadata;
  createdAt: number;
}

export interface PickfordIdentity {
  email: string | null;
  userId: string | null;
}

/** `GET /auth/get_user` on the API origin, once Identity accepts the OAuth bearer (PIC-1739). */
export async function fetchPickfordIdentity(options: {
  apiBaseUrl: string;
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<PickfordIdentity> {
  const response = await options.fetchImpl(`${options.apiBaseUrl}/auth/get_user`, {
    headers: { Authorization: `Bearer ${options.accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Could not read the signed-in Pickford account (HTTP ${response.status}).`);
  }
  const body = await response.json() as { email?: unknown; id?: unknown };
  return {
    email: typeof body.email === 'string' ? body.email : null,
    userId: typeof body.id === 'string' ? body.id : null,
  };
}

export class PickfordAuth {
  private readonly pending = new Map<string, PendingSignIn>();
  private refreshing: Promise<StoredAuth> | null = null;

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

  private async authorizationServer(resource: string): Promise<{ metadata: AuthorizationServerMetadata; resource: string }> {
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
    return { metadata, resource: protectedResource.resource };
  }

  private storedClient(issuer: string, redirectUri: string): StoredClient | null {
    const value = readPrivateJson<StoredClient>(CLIENT_FILE, this.options.env);
    if (!value || value.issuer !== issuer || !Array.isArray(value.redirectUris)) return null;
    return value.redirectUris.includes(redirectUri) ? value : null;
  }

  /** Step 1: register (once per issuer + redirect URI) and hand the browser an authorization URL. */
  async beginSignIn(redirectUri: string): Promise<{ authorizationUrl: string; state: string }> {
    const { metadata, resource } = await this.authorizationServer(this.options.environment.oauthResource);
    let client: StoredClient | RegisteredClient | null = this.storedClient(metadata.issuer, redirectUri);
    if (!client) {
      const registered = await registerClient({
        metadata,
        redirectUris: [redirectUri],
        clientName: CLIENT_NAME,
        softwareId: SOFTWARE_ID,
        softwareVersion: this.options.version,
        fetchImpl: this.fetchImpl,
      });
      const stored: StoredClient = {
        issuer: metadata.issuer,
        clientId: registered.clientId,
        redirectUris: registered.redirectUris,
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
      state, codeVerifier: pkce.codeVerifier, redirectUri, clientId: client.clientId, resource, metadata, createdAt,
    });
    return {
      authorizationUrl: buildAuthorizationUrl({
        metadata, clientId: client.clientId, redirectUri, resource, state, codeChallenge: pkce.codeChallenge,
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

  /** Best-effort: the email is a display convenience, never a gate on the rest of the flow. */
  private async attachIdentity(auth: StoredAuth): Promise<void> {
    try {
      const identity = await fetchPickfordIdentity({
        apiBaseUrl: this.options.environment.apiBaseUrl,
        accessToken: auth.accessToken,
        fetchImpl: this.fetchImpl,
      });
      writeStoredAuth({ ...auth, email: identity.email, userId: identity.userId }, this.options.env);
    } catch {
      // Identity does not accept the renderer's OAuth bearer until PIC-1739 lands.
    }
  }

  /** The stored user id, when Identity told us one. Used to scope the fallback bundle listing. */
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
        fetchImpl: this.fetchImpl,
        now: this.now(),
      });
    } catch (error) {
      // A rejected refresh means the grant is gone; a stale file would refuse forever.
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
    }, tokens);
  }

  async signOut(): Promise<void> {
    const auth = readStoredAuth(this.options.env);
    this.pending.clear();
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
