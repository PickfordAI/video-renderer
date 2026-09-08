import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PickfordAuth } from './pickford-auth.js';
import { accessTokenExpired, authStatus, readStoredAuth, type StoredAuth } from './oauth-store.js';
import { pickfordEnvironment } from './pickford-environment.js';
import { privatePath } from './private-store.js';

const ISSUER = 'https://api.dev.pickford.ai/auth/storykernel';
const RESOURCE = 'https://api.dev.pickford.ai/renderer';
const SCOPE = 'storykernel:renderer';
const BFF = 'https://dev.pickford.ai';
const REDIRECT = 'http://127.0.0.1:4174/auth/pickford/callback';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface FakeOptions {
  refreshFails?: boolean;
  /** `null` means the whoami refuses, which must not undo a valid sign-in. */
  identity?: { id: string; role: string; email?: string } | null;
  advertisedScopes?: string[];
}

function fakeIdentity(options: FakeOptions = {}) {
  const state = { code: 'code-1', challenge: '', redirectUri: '', accessIssued: 0, registrations: 0, registeredScope: '', refreshCalls: 0 };
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const form = typeof init?.body === 'string' && !init.body.startsWith('{')
      ? Object.fromEntries(new URLSearchParams(init.body))
      : null;
    if (url.includes('/.well-known/oauth-protected-resource')) {
      return json({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        ...(options.advertisedScopes ? { scopes_supported: options.advertisedScopes } : {}),
      });
    }
    if (url.includes('/.well-known/oauth-authorization-server')) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        revocation_endpoint: `${ISSUER}/revoke`,
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url === `${ISSUER}/register`) {
      state.registrations += 1;
      state.registeredScope = (JSON.parse(String(init?.body)) as { scope: string }).scope;
      return json({ client_id: 'client-abc', client_id_issued_at: 1 }, 201);
    }
    if (url === `${ISSUER}/token` && form?.grant_type === 'authorization_code') {
      state.accessIssued += 1;
      return json({ access_token: `access-${state.accessIssued}`, refresh_token: 'refresh-1', expires_in: 3600, scope: 'storykernel:onboarding' });
    }
    if (url === `${ISSUER}/token` && form?.grant_type === 'refresh_token') {
      state.refreshCalls += 1;
      if (options.refreshFails) return json({ error: 'invalid_grant' }, 400);
      // Single-use and rotating: replaying refresh-1 after it was spent revokes the grant.
      if (form.refresh_token !== `refresh-${state.refreshCalls}`) return json({ error: 'invalid_grant' }, 400);
      state.accessIssued += 1;
      return json({ access_token: `access-${state.accessIssued}`, refresh_token: `refresh-${state.refreshCalls + 1}`, expires_in: 43_200 });
    }
    if (url === `${ISSUER}/revoke`) return new Response(null, { status: 200 });
    if (url === `${BFF}/bff/v1/session`) {
      // A bearer whoami: no cookie, no CSRF token.
      return options.identity
        ? json({ user_id: options.identity.id, role: options.identity.role, csrf_token: null })
        : json({ detail: 'Identity session required' }, 401);
    }
    if (url.endsWith('/auth/get_user')) {
      return options.identity?.email ? json({ email: options.identity.email, id: options.identity.id }) : json({ detail: 'no' }, 401);
    }
    return json({}, 404);
  };
  return { impl, state };
}

describe('PickfordAuth', () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'renderer-auth-'));
    env = { RENDERER_STATE_DIR: join(directory, '.renderer'), STORY_ENVIRONMENT: 'dev' };
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function auth(identity = fakeIdentity(), now = () => 1_000): PickfordAuth {
    return new PickfordAuth({ environment: pickfordEnvironment(env), fetchImpl: identity.impl, env, now });
  }

  it('registers once and issues an authorization URL bound to the loopback redirect', async () => {
    const identity = fakeIdentity();
    const client = auth(identity);
    const first = await client.beginSignIn(REDIRECT);
    const second = await client.beginSignIn(REDIRECT);
    expect(identity.state.registrations).toBe(1);
    expect(first.state).not.toBe(second.state);
    const url = new URL(first.authorizationUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('resource')).toBe(RESOURCE);
    expect(url.searchParams.get('scope')).toBe(SCOPE);
    expect(identity.state.registeredScope).toBe(SCOPE);
  });

  it('follows the resource metadata when it advertises a single different scope', async () => {
    const identity = fakeIdentity({ advertisedScopes: ['storykernel:renderer-next'] });
    const { authorizationUrl } = await auth(identity).beginSignIn(REDIRECT);
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('storykernel:renderer-next');
  });

  it('re-registers when the paired scope changes, so a stale client is not reused', async () => {
    const identity = fakeIdentity();
    await auth(identity).beginSignIn(REDIRECT);
    const moved = new PickfordAuth({
      environment: { ...pickfordEnvironment(env), oauthScope: 'storykernel:onboarding' },
      fetchImpl: identity.impl, env, now: () => 1_000,
    });
    await moved.beginSignIn(REDIRECT);
    expect(identity.state.registrations).toBe(2);
  });

  it('stores tokens 0600 and reports only a credential-free status', async () => {
    const identity = fakeIdentity({ identity: { email: 'creator@example.com', id: 'b4c9d1e2-0000-4000-8000-000000000001', role: 'creator' } });
    const client = auth(identity);
    const { state } = await client.beginSignIn(REDIRECT);
    const status = await client.completeSignIn({ state, code: 'code-1' });

    expect(status).toMatchObject({ signedIn: true, environment: 'dev', email: 'creator@example.com', role: 'creator' });
    expect(JSON.stringify(status)).not.toContain('access-1');
    expect(statSync(privatePath('auth.json', env)).mode & 0o777).toBe(0o600);
    expect(readStoredAuth(env)?.accessToken).toBe('access-1');
    expect(client.userId()).toBe('b4c9d1e2-0000-4000-8000-000000000001');
  });

  it('stays signed in when the whoami refuses, and keeps the reason as a notice', async () => {
    const client = auth(fakeIdentity({ identity: null }));
    const { state } = await client.beginSignIn(REDIRECT);
    const status = await client.completeSignIn({ state, code: 'code-1' });
    expect(status.signedIn).toBe(true);
    expect(status.email).toBeNull();
    expect(status.role).toBeNull();
    expect(client.notice()).toMatch(/Could not read the signed-in Pickford account/);
  });

  it('says so immediately when the account lacks the creator role', async () => {
    const identity = fakeIdentity();
    const refusing = {
      impl: async (url: string, init?: RequestInit) => (url === `${BFF}/bff/v1/session`
        ? json({ detail: 'Creator or admin role required' }, 403)
        : identity.impl(url, init)),
    };
    const client = auth(refusing as ReturnType<typeof fakeIdentity>);
    const { state } = await client.beginSignIn(REDIRECT);
    expect((await client.completeSignIn({ state, code: 'code-1' })).signedIn).toBe(true);
    expect(client.notice()).toMatch(/does not have the creator role/);
  });

  it('drops the notice once signed out', async () => {
    const client = auth(fakeIdentity({ identity: null }));
    const { state } = await client.beginSignIn(REDIRECT);
    await client.completeSignIn({ state, code: 'code-1' });
    await client.signOut();
    expect(client.notice()).toBeNull();
  });

  it('names the account from the BFF whoami even when Identity withholds the email', async () => {
    const client = auth(fakeIdentity({ identity: { id: 'b4c9d1e2-0000-4000-8000-000000000001', role: 'creator' } }));
    const { state } = await client.beginSignIn(REDIRECT);
    const status = await client.completeSignIn({ state, code: 'code-1' });
    expect(status).toMatchObject({ signedIn: true, email: null, role: 'creator' });
    expect(client.userId()).toBe('b4c9d1e2-0000-4000-8000-000000000001');
  });

  it('refuses a callback whose state was never issued', async () => {
    const client = auth();
    await client.beginSignIn(REDIRECT);
    await expect(client.completeSignIn({ state: 'forged', code: 'code-1' })).rejects.toThrow(/expired/);
  });

  it('spends each state exactly once', async () => {
    const client = auth();
    const { state } = await client.beginSignIn(REDIRECT);
    await client.completeSignIn({ state, code: 'code-1' });
    await expect(client.completeSignIn({ state, code: 'code-1' })).rejects.toThrow(/expired/);
  });

  it('refreshes automatically when the stored access token is near expiry', async () => {
    const identity = fakeIdentity();
    let now = 1_000;
    const client = new PickfordAuth({ environment: pickfordEnvironment(env), fetchImpl: identity.impl, env, now: () => now });
    const { state } = await client.beginSignIn(REDIRECT);
    await client.completeSignIn({ state, code: 'code-1' });
    expect(await client.accessToken()).toBe('access-1');

    now += 43_200_000;
    expect(await client.accessToken()).toBe('access-2');
    expect(readStoredAuth(env)?.refreshToken).toBe('refresh-2');
    // A second read inside the same window reuses the refreshed token instead of refreshing again.
    expect(await client.accessToken()).toBe('access-2');
    expect(identity.state.refreshCalls).toBe(1);
  });

  it('never replays a spent refresh token, which would revoke the grant', async () => {
    const identity = fakeIdentity();
    let now = 1_000;
    const client = new PickfordAuth({ environment: pickfordEnvironment(env), fetchImpl: identity.impl, env, now: () => now });
    const { state } = await client.beginSignIn(REDIRECT);
    await client.completeSignIn({ state, code: 'code-1' });

    // Concurrent demands for a token must collapse into one refresh, not race two.
    now += 43_200_000;
    const [first, second] = await Promise.all([client.accessToken(), client.accessToken()]);
    expect(first).toBe(second);
    expect(identity.state.refreshCalls).toBe(1);

    // The next refresh window uses the rotated token, and the fake rejects any replay.
    now += 43_200_000;
    await expect(client.accessToken()).resolves.toBe('access-3');
    expect(identity.state.refreshCalls).toBe(2);
  });

  it('clears the stored sign-in when the refresh is rejected', async () => {
    const identity = fakeIdentity({ refreshFails: true });
    let now = 1_000;
    const client = new PickfordAuth({ environment: pickfordEnvironment(env), fetchImpl: identity.impl, env, now: () => now });
    const { state } = await client.beginSignIn(REDIRECT);
    await client.completeSignIn({ state, code: 'code-1' });
    now += 43_200_000;
    await expect(client.accessToken()).rejects.toThrow(/Sign in with Pickford again/);
    expect(readStoredAuth(env)).toBeNull();
  });

  it('signs out by clearing local tokens even when revocation fails', async () => {
    const identity = fakeIdentity();
    const failing = { impl: async (url: string, init?: RequestInit) => (url.endsWith('/revoke') ? Promise.reject(new Error('offline')) : identity.impl(url, init)) };
    const client = auth(failing as ReturnType<typeof fakeIdentity>);
    const { state } = await client.beginSignIn(REDIRECT);
    await client.completeSignIn({ state, code: 'code-1' });
    await client.signOut();
    expect(readStoredAuth(env)).toBeNull();
    expect(client.status().signedIn).toBe(false);
  });
});

describe('token store', () => {
  const base: StoredAuth = {
    environment: 'dev', resource: RESOURCE, issuer: ISSUER, clientId: 'c', redirectUri: REDIRECT,
    accessToken: 'a', refreshToken: 'r', scope: SCOPE, expiresAt: 10_000_000, signedInAt: 0,
  };

  it('treats a token inside the refresh skew as expired', () => {
    expect(accessTokenExpired(base, 10_000_000 - 300_000)).toBe(false);
    expect(accessTokenExpired(base, 10_000_000 - 60_000)).toBe(true);
    expect(accessTokenExpired({ ...base, expiresAt: Number.NaN }, 0)).toBe(true);
  });

  it('never puts a token into the public status', () => {
    expect(JSON.stringify(authStatus(base))).not.toMatch(/"a"|"r"/);
    expect(authStatus(null)).toMatchObject({ signedIn: false, email: null });
  });
});
