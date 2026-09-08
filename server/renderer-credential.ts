import { readPrivateJson, removePrivateJson, writePrivateJson } from './private-store.js';
import type { FetchLike } from './oauth-discovery.js';

/**
 * The renderer mints its own installation credential as the signed-in creator, so there is no
 * developer page and no handoff file.
 *
 * The BFF accepts the OAuth access token directly on these routes (PIC-1739) with no CSRF, so
 * `bearer` is the only adapter a current Pickford environment uses. The `browser-session` adapter
 * (`POST /bff/v1/session` for a cookie + CSRF token, then replay the mutation) is kept dormant
 * behind it for an older BFF that still enforces the browser boundary; it is only reached when the
 * bearer attempt is refused with 401.
 *
 * Both talk to the frontend origin, which is where `/bff/v1/*` is served on deployed environments.
 */

export const CREDENTIAL_FILE = 'credential.json';
export const CSRF_COOKIE_NAME = 'storykernel_csrf';
const REQUEST_TIMEOUT_MS = 30_000;

export type CredentialAdapter = 'bearer' | 'browser-session';

export interface StoredCredential {
  environment: string;
  rendererId: string;
  credentialId: string;
  clientSecret: string;
  installationName: string;
  adapter: CredentialAdapter;
  createdAt: string;
  rotatedAt: string | null;
  expiresAt: string | null;
}

/** Credential-free view for the page: the client secret never leaves `.renderer/`. */
export interface CredentialStatus {
  present: boolean;
  rendererId: string | null;
  installationName: string | null;
  adapter: CredentialAdapter | null;
  rotatedAt: string | null;
  expiresAt: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Pickford returned no ${label}.`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Parses `BrowserRendererCredentialSecret` into the fields the renderer bridge needs. */
export function parseMintedCredential(body: unknown): Omit<StoredCredential, 'environment' | 'adapter'> {
  const value = (body ?? {}) as { credential?: unknown; client_secret?: unknown };
  const credential = (value.credential ?? {}) as Record<string, unknown>;
  const rendererId = text(credential.renderer_id, 'renderer id');
  const credentialId = text(credential.credential_id, 'credential id');
  if (!UUID.test(rendererId) || !UUID.test(credentialId)) throw new Error('Pickford returned a malformed renderer identity.');
  return {
    rendererId,
    credentialId,
    clientSecret: text(value.client_secret, 'client secret'),
    installationName: optionalText(credential.installation_name) ?? 'Local renderer',
    createdAt: optionalText(credential.created_at) ?? new Date().toISOString(),
    rotatedAt: optionalText(credential.rotated_at),
    expiresAt: optionalText(credential.expires_at),
  };
}

export function readStoredCredential(env?: NodeJS.ProcessEnv): StoredCredential | null {
  const value = readPrivateJson<StoredCredential>(CREDENTIAL_FILE, env);
  if (!value || typeof value.clientSecret !== 'string' || !UUID.test(value.rendererId ?? '')) return null;
  return value;
}

export function writeStoredCredential(value: StoredCredential, env?: NodeJS.ProcessEnv): void {
  writePrivateJson(CREDENTIAL_FILE, value, env);
}

export function clearStoredCredential(env?: NodeJS.ProcessEnv): void {
  removePrivateJson(CREDENTIAL_FILE, env);
}

export function credentialStatus(credential: StoredCredential | null): CredentialStatus {
  if (!credential) {
    return { present: false, rendererId: null, installationName: null, adapter: null, rotatedAt: null, expiresAt: null };
  }
  return {
    present: true,
    rendererId: credential.rendererId,
    installationName: credential.installationName,
    adapter: credential.adapter,
    rotatedAt: credential.rotatedAt,
    expiresAt: credential.expiresAt,
  };
}

interface BrowserSession {
  cookieHeader: string;
  csrfToken: string;
}

function cookieValue(setCookies: readonly string[], name: string): string | null {
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    if (index > 0 && pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return null;
}

/** Builds the cookie header for the CSRF replay from a `POST /bff/v1/session` response. */
export function browserSessionFrom(setCookies: readonly string[], body: unknown): BrowserSession {
  // A current BFF answers a bearer with `csrf_token: null` and sets no cookie; that is the signal
  // that the browser boundary does not apply and the bearer attempt should have succeeded.
  const csrfToken = text(((body ?? {}) as { csrf_token?: unknown }).csrf_token, 'CSRF token');
  const cookies = setCookies
    .map(cookie => cookie.split(';')[0].trim())
    .filter(pair => pair.includes('=') && !pair.endsWith('='));
  if (!cookies.length) throw new Error('Pickford established no browser session cookie.');
  const csrfCookie = cookieValue(setCookies, CSRF_COOKIE_NAME);
  if (csrfCookie && csrfCookie !== csrfToken) throw new Error('Pickford returned a mismatched CSRF proof.');
  return { cookieHeader: cookies.join('; '), csrfToken };
}

async function establishBrowserSession(options: {
  bffBaseUrl: string;
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<BrowserSession> {
  const response = await options.fetchImpl(`${options.bffBaseUrl}/bff/v1/session`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(response.status === 401
      ? 'Pickford did not accept this sign-in for the developer API. Sign in with Pickford again.'
      : `Establishing the Pickford developer session failed (HTTP ${response.status}).`);
  }
  const setCookies = response.headers.getSetCookie?.() ?? [];
  return browserSessionFrom(setCookies, await response.json());
}

function mutationFailure(status: number, label: string): Error {
  if (status === 429) {
    // The developer budget is 20 mutations a day, which one creator cannot reach by hand.
    return new Error(`${label} was rate limited by Pickford. Wait and try again, or ask an admin to raise the developer limit.`);
  }
  if (status === 403) return new Error(`${label} was refused: this account needs the creator or admin role.`);
  return new Error(`${label} failed (HTTP ${status}).`);
}

async function readMutation(response: Response, label: string): Promise<unknown> {
  if (response.ok) return await response.json();
  await response.body?.cancel().catch(() => undefined);
  throw mutationFailure(response.status, label);
}

async function mutate(options: {
  url: string;
  accessToken: string;
  body: string | null;
  label: string;
  fetchImpl: FetchLike;
}): Promise<{ body: unknown; adapter: CredentialAdapter }> {
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    Authorization: `Bearer ${options.accessToken}`,
    Accept: 'application/json',
    ...(options.body === null ? {} : { 'Content-Type': 'application/json' }),
    ...extra,
  });
  const bearer = await options.fetchImpl(options.url, {
    method: 'POST',
    headers: headers(),
    ...(options.body === null ? {} : { body: options.body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (bearer.ok) return { body: await bearer.json(), adapter: 'bearer' };
  await bearer.body?.cancel().catch(() => undefined);
  // A current BFF accepts the bearer, so 403 is a real role denial rather than a CSRF boundary and
  // must not be retried through the session path. Only 401 falls through to the dormant adapter.
  if (bearer.status !== 401) throw mutationFailure(bearer.status, options.label);
  const session = await establishBrowserSession({
    bffBaseUrl: new URL(options.url).origin,
    accessToken: options.accessToken,
    fetchImpl: options.fetchImpl,
  });
  const replay = await options.fetchImpl(options.url, {
    method: 'POST',
    headers: headers({ Cookie: session.cookieHeader, 'X-CSRF-Token': session.csrfToken }),
    ...(options.body === null ? {} : { body: options.body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { body: await readMutation(replay, options.label), adapter: 'browser-session' };
}

export async function mintRendererCredential(options: {
  bffBaseUrl: string;
  accessToken: string;
  environment: string;
  installationName?: string;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}): Promise<StoredCredential> {
  const installationName = options.installationName ?? 'Local video renderer';
  const { body, adapter } = await mutate({
    url: `${options.bffBaseUrl}/bff/v1/developer/renderers`,
    accessToken: options.accessToken,
    body: JSON.stringify({ installation_name: installationName }),
    label: 'Creating this renderer installation',
    fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
  });
  const credential: StoredCredential = { ...parseMintedCredential(body), environment: options.environment, adapter };
  writeStoredCredential(credential, options.env);
  return credential;
}

export async function rotateRendererCredential(options: {
  bffBaseUrl: string;
  accessToken: string;
  credential: StoredCredential;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}): Promise<StoredCredential> {
  const { body, adapter } = await mutate({
    url: `${options.bffBaseUrl}/bff/v1/developer/renderers/${options.credential.rendererId}/rotate`,
    accessToken: options.accessToken,
    body: null,
    label: 'Rotating this renderer credential',
    fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
  });
  const rotated: StoredCredential = {
    ...parseMintedCredential(body),
    environment: options.credential.environment,
    adapter,
  };
  writeStoredCredential(rotated, options.env);
  return rotated;
}

/**
 * The renderer platform fences a credential when it is revoked, rotated elsewhere, or replaced by
 * another connection. The bridge surfaces that as an authentication failure on the run, which is
 * the cue to rotate rather than to ask the creator to do anything.
 */
export function credentialFenced(failures: readonly string[]): boolean {
  return failures.some(failure => /fenced|invalid[_ ]client|unauthori[sz]ed|forbidden|revoked|\b40[13]\b/i.test(failure));
}
