import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { AuthorizationServerMetadata, FetchLike } from './oauth-discovery.js';

/**
 * OAuth 2.1 public client: dynamic registration (RFC 7591), authorization code with PKCE S256
 * (RFC 7636), resource indicators (RFC 8707), and refresh-token rotation. The renderer holds no
 * client secret; `token_endpoint_auth_method` is `none`, which is what Pickford advertises.
 *
 * Refresh tokens are single-use and rotate: replaying one revokes the whole grant. So a refresh is
 * attempted exactly once per stored token and is never retried with the same value — see
 * `PickfordAuth.refresh`, which discards the stored sign-in rather than trying again.
 */

const REQUEST_TIMEOUT_MS = 30_000;

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  registeredAt: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  scope: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export function pkceChallengeFor(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

export function createPkcePair(random: (size: number) => Buffer = randomBytes): PkcePair {
  // 32 random bytes base64url-encode to the 43 characters Identity's authorize schema requires.
  const codeVerifier = random(32).toString('base64url');
  return { codeVerifier, codeChallenge: pkceChallengeFor(codeVerifier), codeChallengeMethod: 'S256' };
}

export function createState(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString('base64url');
}

export function statesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function failure(response: Response, label: string): Promise<Error> {
  let detail = '';
  try {
    const body = await response.json() as { error?: unknown; error_description?: unknown };
    // Never echo the raw body: token endpoints reflect request parameters, which carry secrets.
    const code = typeof body.error === 'string' ? body.error : '';
    const description = typeof body.error_description === 'string' ? body.error_description : '';
    detail = [code, description].filter(Boolean).join(': ');
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }
  return new Error(`${label} failed (HTTP ${response.status}${detail ? `, ${detail}` : ''}).`);
}

export async function registerClient(options: {
  metadata: AuthorizationServerMetadata;
  redirectUris: string[];
  clientName: string;
  /** Must be the scope paired with the resource this client will request. */
  scope: string;
  clientUri?: string;
  softwareId?: string;
  softwareVersion?: string;
  fetchImpl: FetchLike;
}): Promise<RegisteredClient> {
  const response = await options.fetchImpl(options.metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: options.clientName,
      redirect_uris: options.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: options.scope,
      ...(options.clientUri ? { client_uri: options.clientUri } : {}),
      ...(options.softwareId ? { software_id: options.softwareId } : {}),
      ...(options.softwareVersion ? { software_version: options.softwareVersion } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await failure(response, 'Registering this renderer with Pickford');
  const body = await response.json() as { client_id?: unknown; client_id_issued_at?: unknown };
  if (typeof body.client_id !== 'string' || !body.client_id) throw new Error('Pickford did not return a client_id.');
  return {
    clientId: body.client_id,
    redirectUris: options.redirectUris,
    registeredAt: typeof body.client_id_issued_at === 'number' ? body.client_id_issued_at * 1000 : Date.now(),
  };
}

export function buildAuthorizationUrl(options: {
  metadata: AuthorizationServerMetadata;
  clientId: string;
  redirectUri: string;
  resource: string;
  state: string;
  codeChallenge: string;
  scope: string;
}): string {
  const url = new URL(options.metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', options.resource);
  url.searchParams.set('state', options.state);
  url.searchParams.set('scope', options.scope);
  return url.toString();
}

function parseTokenResponse(body: unknown, now: number, requestedScope: string): TokenSet {
  const value = (body ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  if (typeof value.access_token !== 'string' || !value.access_token) throw new Error('Pickford returned no access token.');
  if (typeof value.refresh_token !== 'string' || !value.refresh_token) {
    throw new Error('Pickford returned no refresh token, so the renderer could not stay signed in.');
  }
  const expiresIn = typeof value.expires_in === 'number' && Number.isFinite(value.expires_in) ? value.expires_in : 3600;
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    scope: typeof value.scope === 'string' ? value.scope : requestedScope,
    expiresAt: now + Math.max(0, Math.floor(expiresIn)) * 1000,
  };
}

async function requestToken(
  metadata: AuthorizationServerMetadata,
  form: Record<string, string>,
  fetchImpl: FetchLike,
  now: number,
  label: string,
  requestedScope: string,
): Promise<TokenSet> {
  const response = await fetchImpl(metadata.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await failure(response, label);
  return parseTokenResponse(await response.json(), now, requestedScope);
}

export async function exchangeAuthorizationCode(options: {
  metadata: AuthorizationServerMetadata;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
  scope: string;
  fetchImpl: FetchLike;
  now?: number;
}): Promise<TokenSet> {
  return await requestToken(options.metadata, {
    grant_type: 'authorization_code',
    client_id: options.clientId,
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
    resource: options.resource,
  }, options.fetchImpl, options.now ?? Date.now(), 'Completing the Pickford sign-in', options.scope);
}

export async function refreshAccessToken(options: {
  metadata: AuthorizationServerMetadata;
  clientId: string;
  refreshToken: string;
  resource: string;
  scope: string;
  fetchImpl: FetchLike;
  now?: number;
}): Promise<TokenSet> {
  return await requestToken(options.metadata, {
    grant_type: 'refresh_token',
    client_id: options.clientId,
    refresh_token: options.refreshToken,
    resource: options.resource,
  }, options.fetchImpl, options.now ?? Date.now(), 'Refreshing the Pickford sign-in', options.scope);
}

export async function revokeRefreshToken(options: {
  metadata: AuthorizationServerMetadata;
  clientId: string;
  refreshToken: string;
  fetchImpl: FetchLike;
}): Promise<void> {
  if (!options.metadata.revocationEndpoint) return;
  const response = await options.fetchImpl(options.metadata.revocationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: options.refreshToken, client_id: options.clientId }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => undefined);
}
