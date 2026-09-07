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
  type AuthorizationServerMetadata,
} from './oauth-discovery.js';

const ISSUER = 'https://api.dev.pickford.ai/auth/storykernel';
const RESOURCE = 'https://api.dev.pickford.ai/storykernel/mcp';

const metadata: AuthorizationServerMetadata = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  registrationEndpoint: `${ISSUER}/register`,
  revocationEndpoint: `${ISSUER}/revoke`,
  scopesSupported: ['storykernel:onboarding'],
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
    if (url.endsWith('/.well-known/oauth-protected-resource/storykernel/mcp')) {
      return json({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ['storykernel:onboarding'] });
    }
    if (url.endsWith('/.well-known/oauth-authorization-server/auth/storykernel')) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: metadata.authorizationEndpoint,
        token_endpoint: metadata.tokenEndpoint,
        registration_endpoint: metadata.registrationEndpoint,
        revocation_endpoint: metadata.revocationEndpoint,
        scopes_supported: ['storykernel:onboarding'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url === metadata.registrationEndpoint) {
      const payload = JSON.parse(String(init?.body)) as { redirect_uris: string[]; token_endpoint_auth_method: string };
      expect(payload.token_endpoint_auth_method).toBe('none');
      expect(payload.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      return json({ client_id: 'client-abc', client_id_issued_at: 1_700_000_000 }, 201);
    }
    if (url === metadata.tokenEndpoint && form?.grant_type === 'authorization_code') {
      const record = codes.get(form.code);
      if (!record) return json({ error: 'invalid_grant' }, 400);
      if (record.challenge !== pkceChallengeFor(form.code_verifier)) return json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, 400);
      if (record.redirectUri !== form.redirect_uri || record.resource !== form.resource) return json({ error: 'invalid_request' }, 400);
      issued += 1;
      return json({ access_token: `access-${issued}`, refresh_token: refreshToken, expires_in: 3600, scope: 'storykernel:onboarding', token_type: 'Bearer' });
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
      resource: RESOURCE, state: 'state-1', codeChallenge: 'c'.repeat(43),
    }));
    expect(url.origin + url.pathname).toBe(metadata.authorizationEndpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-abc',
      redirect_uri: 'http://127.0.0.1:4174/auth/pickford/callback',
      code_challenge_method: 'S256',
      resource: RESOURCE,
      state: 'state-1',
      scope: 'storykernel:onboarding',
    });
  });
});

describe('discovery', () => {
  it('probes the RFC 9728 locations Pickford serves', () => {
    expect(resourceMetadataUrls(RESOURCE)).toContain('https://api.dev.pickford.ai/.well-known/oauth-protected-resource/storykernel/mcp');
    expect(resourceMetadataUrls(RESOURCE)).toContain('https://api.dev.pickford.ai/storykernel/mcp/.well-known/oauth-protected-resource');
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
    const client = await registerClient({ metadata, redirectUris: [redirectUri], clientName: 'test', fetchImpl: identity.impl });
    expect(client.clientId).toBe('client-abc');

    const pkce = createPkcePair();
    identity.authorize('code-1', pkce.codeChallenge, redirectUri);
    const tokens = await exchangeAuthorizationCode({
      metadata, clientId: client.clientId, code: 'code-1', redirectUri,
      codeVerifier: pkce.codeVerifier, resource: RESOURCE, fetchImpl: identity.impl, now: 1_000,
    });
    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.expiresAt).toBe(1_000 + 3_600_000);

    identity.authorize('code-2', pkce.codeChallenge, redirectUri);
    await expect(exchangeAuthorizationCode({
      metadata, clientId: client.clientId, code: 'code-2', redirectUri,
      codeVerifier: createPkcePair().codeVerifier, resource: RESOURCE, fetchImpl: identity.impl,
    })).rejects.toThrow(/PKCE mismatch/);
  });

  it('refuses a token response with no refresh token, so the renderer never silently expires', async () => {
    const impl = async (): Promise<Response> => json({ access_token: 'a', expires_in: 60 });
    await expect(refreshAccessToken({ metadata, clientId: 'c', refreshToken: 'r', resource: RESOURCE, fetchImpl: impl }))
      .rejects.toThrow(/no refresh token/);
  });

  it('rotates the refresh token on refresh', async () => {
    const identity = fakeIdentity();
    const first = await refreshAccessToken({ metadata, clientId: 'client-abc', refreshToken: 'refresh-1', resource: RESOURCE, fetchImpl: identity.impl, now: 0 });
    expect(first.refreshToken).not.toBe('refresh-1');
    await expect(refreshAccessToken({ metadata, clientId: 'client-abc', refreshToken: 'refresh-1', resource: RESOURCE, fetchImpl: identity.impl }))
      .rejects.toThrow(/invalid_grant/);
  });

  it('never echoes request parameters back into an error message', async () => {
    const impl = async (): Promise<Response> => json({ error: 'invalid_grant', error_description: 'bad code', code_verifier: 'secret-verifier' }, 400);
    await expect(exchangeAuthorizationCode({
      metadata, clientId: 'c', code: 'x', redirectUri: 'http://127.0.0.1:4174/cb', codeVerifier: 'secret-verifier', resource: RESOURCE, fetchImpl: impl,
    })).rejects.toThrow(/^Completing the Pickford sign-in failed \(HTTP 400, invalid_grant: bad code\)\.$/);
  });

  it('posts the refresh token to the revocation endpoint on sign-out', async () => {
    const identity = fakeIdentity();
    await revokeRefreshToken({ metadata, clientId: 'client-abc', refreshToken: 'refresh-1', fetchImpl: identity.impl });
    expect(identity.calls.at(-1)).toMatchObject({ url: metadata.revocationEndpoint, body: { token: 'refresh-1', client_id: 'client-abc' } });
  });
});
