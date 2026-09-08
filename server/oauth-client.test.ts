import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  buildAuthorizationUrl,
  createPkcePair,
  createState,
  exchangeAuthorizationCode,
  pkceChallengeFor,
  refreshAccessToken,
  registerClient,
  revokeRefreshToken,
  statesMatch,
} from './oauth-client.js';
import {
  authorizationServerMetadataUrls,
  discoverAuthorizationServer,
  discoverProtectedResource,
  resourceMetadataFromChallenge,
  resourceMetadataUrls,
  sameResource,
  type AuthorizationServerMetadata,
} from './oauth-discovery.js';
import { pickfordEnvironment, scopeForResource } from './pickford-environment.js';

const ISSUER = 'https://api.dev.pickford.ai/auth/storykernel';
const RESOURCE = 'https://api.dev.pickford.ai/renderer';
const SCOPE = 'storykernel:renderer';

const metadata: AuthorizationServerMetadata = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  registrationEndpoint: `${ISSUER}/register`,
  revocationEndpoint: `${ISSUER}/revoke`,
  scopesSupported: [SCOPE],
  codeChallengeMethodsSupported: ['S256'],
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A fake Pickford Identity that enforces PKCE, resource binding and refresh rotation. */
function fakeIdentity() {
  const calls: Array<{ url: string; body: Record<string, string> | null }> = [];
  const codes = new Map<string, { challenge: string; redirectUri: string; resource: string }>();
  let refreshToken = 'refresh-1';
  let issued = 0;
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const form = typeof init?.body === 'string' && init.headers && String((init.headers as Record<string, string>)['Content-Type']).includes('form-urlencoded')
      ? Object.fromEntries(new URLSearchParams(init.body))
      : null;
    calls.push({ url, body: form });
    if (url.endsWith('/.well-known/oauth-protected-resource/renderer')) {
      return json({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: [SCOPE] });
    }
    if (url.endsWith('/.well-known/oauth-authorization-server/auth/storykernel')) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: metadata.authorizationEndpoint,
        token_endpoint: metadata.tokenEndpoint,
        registration_endpoint: metadata.registrationEndpoint,
        revocation_endpoint: metadata.revocationEndpoint,
        scopes_supported: [SCOPE],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url === metadata.registrationEndpoint) {
      const payload = JSON.parse(String(init?.body)) as { redirect_uris: string[]; token_endpoint_auth_method: string; scope: string };
      expect(payload.token_endpoint_auth_method).toBe('none');
      // Identity pairs resource and scope; a client registered for the wrong one cannot authorize.
      expect(payload.scope).toBe(SCOPE);
      expect(payload.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      return json({ client_id: 'client-abc', client_id_issued_at: 1_700_000_000 }, 201);
    }
    if (url === metadata.tokenEndpoint && form?.grant_type === 'authorization_code') {
      const record = codes.get(form.code);
      if (!record) return json({ error: 'invalid_grant' }, 400);
      if (record.challenge !== pkceChallengeFor(form.code_verifier)) return json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, 400);
      if (record.redirectUri !== form.redirect_uri || record.resource !== form.resource) return json({ error: 'invalid_request' }, 400);
      if (form.scope !== undefined && form.scope !== SCOPE) return json({ error: 'invalid_scope' }, 400);
      issued += 1;
      return json({ access_token: `access-${issued}`, refresh_token: refreshToken, expires_in: 43_200, scope: SCOPE, token_type: 'Bearer' });
    }
    if (url === metadata.tokenEndpoint && form?.grant_type === 'refresh_token') {
      if (form.refresh_token !== refreshToken) return json({ error: 'invalid_grant' }, 400);
      issued += 1;
      refreshToken = `refresh-${issued + 1}`;
      return json({ access_token: `access-${issued}`, refresh_token: refreshToken, expires_in: 60, scope: 'storykernel:onboarding' });
    }
    if (url === metadata.revocationEndpoint) return new Response(null, { status: 200 });
    if (url === RESOURCE) return new Response('{}', { status: 401, headers: { 'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource"` } });
    return json({ error: 'not_found' }, 404);
  };
  return { impl, calls, authorize: (code: string, challenge: string, redirectUri: string) => codes.set(code, { challenge, redirectUri, resource: RESOURCE }) };
}

describe('PKCE', () => {
  it('derives an S256 challenge Identity accepts', () => {
    const pair = createPkcePair();
    expect(pair.codeChallengeMethod).toBe('S256');
    // Identity's authorize schema requires exactly 43 base64url characters.
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.codeChallenge).toBe(createHash('sha256').update(pair.codeVerifier).digest('base64url'));
  });

  it('never repeats a verifier or a state', () => {
    const verifiers = new Set(Array.from({ length: 20 }, () => createPkcePair().codeVerifier));
    const states = new Set(Array.from({ length: 20 }, () => createState()));
    expect(verifiers.size).toBe(20);
    expect(states.size).toBe(20);
  });

  it('compares states without leaking length-independent timing', () => {
    expect(statesMatch('abc', 'abc')).toBe(true);
    expect(statesMatch('abc', 'abd')).toBe(false);
    expect(statesMatch('abc', 'abcd')).toBe(false);
  });
});

describe('authorization request', () => {
  it('carries the resource indicator, PKCE challenge and loopback redirect', () => {
    const url = new URL(buildAuthorizationUrl({
      metadata, clientId: 'client-abc', redirectUri: 'http://127.0.0.1:4174/auth/pickford/callback',
      resource: RESOURCE, scope: SCOPE, state: 'state-1', codeChallenge: 'c'.repeat(43),
    }));
    expect(url.origin + url.pathname).toBe(metadata.authorizationEndpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-abc',
      redirect_uri: 'http://127.0.0.1:4174/auth/pickford/callback',
      code_challenge_method: 'S256',
      resource: RESOURCE,
      state: 'state-1',
      scope: SCOPE,
    });
  });
});

describe('scope pairing', () => {
  it('pairs each resource with the only scope Identity accepts for it', () => {
    expect(scopeForResource('https://api.dev.pickford.ai/renderer')).toBe('storykernel:renderer');
    expect(scopeForResource('https://api.pickford.ai/renderer')).toBe('storykernel:renderer');
    expect(scopeForResource('https://api.dev.pickford.ai/storykernel/mcp')).toBe('storykernel:onboarding');
  });

  it('defaults the renderer to its own resource and scope, per environment', () => {
    expect(pickfordEnvironment({ STORY_ENVIRONMENT: 'dev' })).toMatchObject({
      apiBaseUrl: 'https://api.dev.pickford.ai',
      webBaseUrl: 'https://dev.pickford.ai',
      chatBaseUrl: 'https://chat.dev.pickford.ai',
      oauthResource: 'https://api.dev.pickford.ai/renderer',
      oauthScope: 'storykernel:renderer',
    });
    expect(pickfordEnvironment({ STORY_ENVIRONMENT: 'prod' })).toMatchObject({
      apiBaseUrl: 'https://api.pickford.ai',
      chatBaseUrl: 'https://chat.pickford.ai',
      oauthResource: 'https://api.pickford.ai/renderer',
      oauthScope: 'storykernel:renderer',
    });
    expect(pickfordEnvironment({ STORY_ENVIRONMENT: 'local' })).toMatchObject({
      apiBaseUrl: 'http://127.0.0.1:8081',
      webBaseUrl: 'http://127.0.0.1:5173',
      chatBaseUrl: 'http://127.0.0.1:8080',
      oauthResource: 'http://localhost:8090/renderer',
      oauthScope: 'storykernel:renderer',
    });
  });

  it('uses the configured chat backend for the public audience exchange', () => {
    expect(pickfordEnvironment({
      STORY_ENVIRONMENT: 'dev',
      CHAT_BACKEND_URL: 'https://chat.preview.example/api',
    })).toMatchObject({ chatBaseUrl: 'https://chat.preview.example/api' });
  });

  it('keeps an overridden resource paired with the right scope', () => {
    expect(pickfordEnvironment({ PICKFORD_OAUTH_RESOURCE: 'https://api.dev.pickford.ai/storykernel/mcp' }))
      .toMatchObject({ oauthScope: 'storykernel:onboarding' });
    expect(pickfordEnvironment({ PICKFORD_OAUTH_SCOPE: 'storykernel:something-else' }))
      .toMatchObject({ oauthScope: 'storykernel:something-else' });
  });
});

describe('discovery', () => {
  it('probes the RFC 9728 locations Pickford serves', () => {
    expect(resourceMetadataUrls(RESOURCE)).toContain('https://api.dev.pickford.ai/.well-known/oauth-protected-resource/renderer');
    expect(resourceMetadataUrls(RESOURCE)).toContain('https://api.dev.pickford.ai/renderer/.well-known/oauth-protected-resource');
    expect(authorizationServerMetadataUrls(ISSUER)).toContain('https://api.dev.pickford.ai/.well-known/oauth-authorization-server/auth/storykernel');
  });

  it('reads resource_metadata out of a WWW-Authenticate challenge', () => {
    expect(resourceMetadataFromChallenge('Bearer error="invalid_token", resource_metadata="https://api.dev.pickford.ai/storykernel/mcp/.well-known/oauth-protected-resource"'))
      .toBe('https://api.dev.pickford.ai/storykernel/mcp/.well-known/oauth-protected-resource');
    expect(resourceMetadataFromChallenge('Bearer error="invalid_token"')).toBeNull();
    expect(resourceMetadataFromChallenge('Bearer resource_metadata="http://evil.example/x"')).toBeNull();
  });

  it('follows the resource metadata to its authorization server', async () => {
    const identity = fakeIdentity();
    const resource = await discoverProtectedResource(RESOURCE, identity.impl);
    expect(resource.authorizationServers).toEqual([ISSUER]);
    const server = await discoverAuthorizationServer(resource.authorizationServers[0], identity.impl);
    expect(server.tokenEndpoint).toBe(metadata.tokenEndpoint);
  });

  it('refuses metadata that describes a different resource on the same origin', async () => {
    // Pickford's bare-origin document describes the hosted MCP. Adopting it for the renderer
    // resource would bind tokens to the wrong audience and scope, so every candidate is checked.
    const seen: string[] = [];
    const impl = async (url: string): Promise<Response> => {
      seen.push(url);
      return json({
        resource: 'https://api.dev.pickford.ai/storykernel/mcp',
        authorization_servers: [ISSUER],
        scopes_supported: ['storykernel:onboarding'],
      });
    };
    await expect(discoverProtectedResource(RESOURCE, impl)).rejects.toThrow(/describes https:\/\/api\.dev\.pickford\.ai\/storykernel\/mcp, not the requested resource/);
    // It kept trying the remaining candidates rather than stopping at the first mismatch.
    expect(seen.length).toBeGreaterThan(1);
  });

  it('accepts metadata whose resource differs only by a trailing slash', async () => {
    const impl = async (): Promise<Response> => json({ resource: `${RESOURCE}/`, authorization_servers: [ISSUER] });
    await expect(discoverProtectedResource(RESOURCE, impl)).resolves.toMatchObject({ authorizationServers: [ISSUER] });
    expect(sameResource(`${RESOURCE}/`, RESOURCE)).toBe(true);
    expect(sameResource('https://api.dev.pickford.ai/renderer', 'https://api.dev.pickford.ai/storykernel/mcp')).toBe(false);
  });

  it('refuses an authorization server that is not on the issuer origin', async () => {
    const impl = async (): Promise<Response> => json({
      issuer: 'https://evil.example/auth', authorization_endpoint: 'https://evil.example/a',
      token_endpoint: 'https://evil.example/t', registration_endpoint: 'https://evil.example/r',
    });
    await expect(discoverAuthorizationServer(ISSUER, impl)).rejects.toThrow(/different origin/);
  });
});

describe('token exchange', () => {
  it('registers, exchanges a code, and refuses a mismatched verifier', async () => {
    const identity = fakeIdentity();
    const redirectUri = 'http://127.0.0.1:4174/auth/pickford/callback';
    const client = await registerClient({ metadata, redirectUris: [redirectUri], clientName: 'test', scope: SCOPE, fetchImpl: identity.impl });
    expect(client.clientId).toBe('client-abc');

    const pkce = createPkcePair();
    identity.authorize('code-1', pkce.codeChallenge, redirectUri);
    const tokens = await exchangeAuthorizationCode({
      metadata, clientId: client.clientId, code: 'code-1', redirectUri,
      codeVerifier: pkce.codeVerifier, resource: RESOURCE, scope: SCOPE, fetchImpl: identity.impl, now: 1_000,
    });
    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.expiresAt).toBe(1_000 + 43_200_000);

    identity.authorize('code-2', pkce.codeChallenge, redirectUri);
    await expect(exchangeAuthorizationCode({
      metadata, clientId: client.clientId, code: 'code-2', redirectUri,
      codeVerifier: createPkcePair().codeVerifier, resource: RESOURCE, scope: SCOPE, fetchImpl: identity.impl,
    })).rejects.toThrow(/PKCE mismatch/);
  });

  it('refuses a token response with no refresh token, so the renderer never silently expires', async () => {
    const impl = async (): Promise<Response> => json({ access_token: 'a', expires_in: 60 });
    await expect(refreshAccessToken({ metadata, clientId: 'c', refreshToken: 'r', resource: RESOURCE, scope: SCOPE, fetchImpl: impl }))
      .rejects.toThrow(/no refresh token/);
  });

  it('rotates the refresh token on refresh', async () => {
    const identity = fakeIdentity();
    const first = await refreshAccessToken({ metadata, clientId: 'client-abc', refreshToken: 'refresh-1', resource: RESOURCE, scope: SCOPE, fetchImpl: identity.impl, now: 0 });
    expect(first.refreshToken).not.toBe('refresh-1');
    await expect(refreshAccessToken({ metadata, clientId: 'client-abc', refreshToken: 'refresh-1', resource: RESOURCE, scope: SCOPE, fetchImpl: identity.impl }))
      .rejects.toThrow(/invalid_grant/);
  });

  it('never echoes request parameters back into an error message', async () => {
    const impl = async (): Promise<Response> => json({ error: 'invalid_grant', error_description: 'bad code', code_verifier: 'secret-verifier' }, 400);
    await expect(exchangeAuthorizationCode({
      metadata, clientId: 'c', code: 'x', redirectUri: 'http://127.0.0.1:4174/cb', codeVerifier: 'secret-verifier', resource: RESOURCE, scope: SCOPE, fetchImpl: impl,
    })).rejects.toThrow(/^Completing the Pickford sign-in failed \(HTTP 400, invalid_grant: bad code\)\.$/);
  });

  it('posts the refresh token to the revocation endpoint on sign-out', async () => {
    const identity = fakeIdentity();
    await revokeRefreshToken({ metadata, clientId: 'client-abc', refreshToken: 'refresh-1', fetchImpl: identity.impl });
    expect(identity.calls.at(-1)).toMatchObject({ url: metadata.revocationEndpoint, body: { token: 'refresh-1', client_id: 'client-abc' } });
  });
});
