import { readPrivateJson, removePrivateJson, writePrivateJson } from './private-store.js';

/** `.renderer/auth.json`: the creator's Pickford tokens. 0600, never served, never logged. */
export const AUTH_FILE = 'auth.json';

export interface StoredAuth {
  environment: string;
  resource: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string;
  scope: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  signedInAt: number;
  email?: string | null;
  userId?: string | null;
  role?: string | null;
}

/** Public, credential-free view of the sign-in. This is the only shape the page ever sees. */
export interface AuthStatus {
  signedIn: boolean;
  environment: string | null;
  email: string | null;
  /** `creator` or `admin`; the developer API refuses anything else. */
  role: string | null;
  scope: string | null;
  expiresAt: string | null;
}

export const REFRESH_SKEW_MS = 120_000;

export function readStoredAuth(env?: NodeJS.ProcessEnv): StoredAuth | null {
  const value = readPrivateJson<StoredAuth>(AUTH_FILE, env);
  if (!value || typeof value.accessToken !== 'string' || typeof value.refreshToken !== 'string') return null;
  if (typeof value.clientId !== 'string' || typeof value.issuer !== 'string' || typeof value.resource !== 'string') return null;
  return value;
}

export function writeStoredAuth(value: StoredAuth, env?: NodeJS.ProcessEnv): void {
  writePrivateJson(AUTH_FILE, value, env);
}

export function clearStoredAuth(env?: NodeJS.ProcessEnv): void {
  removePrivateJson(AUTH_FILE, env);
}

export function accessTokenExpired(auth: StoredAuth, now: number, skewMs = REFRESH_SKEW_MS): boolean {
  return !Number.isFinite(auth.expiresAt) || auth.expiresAt - skewMs <= now;
}

export function authStatus(auth: StoredAuth | null): AuthStatus {
  if (!auth) return { signedIn: false, environment: null, email: null, role: null, scope: null, expiresAt: null };
  return {
    signedIn: true,
    environment: auth.environment,
    email: auth.email ?? null,
    role: auth.role ?? null,
    scope: auth.scope,
    expiresAt: Number.isFinite(auth.expiresAt) ? new Date(auth.expiresAt).toISOString() : null,
  };
}
