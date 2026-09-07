import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { privatePath } from './private-store.js';
import {
  browserSessionFrom,
  credentialFenced,
  credentialStatus,
  mintRendererCredential,
  parseMintedCredential,
  readStoredCredential,
  rotateRendererCredential,
} from './renderer-credential.js';

const BFF = 'https://dev.pickford.ai';
const RENDERER_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const CREDENTIAL_ID = 'a1b2c3d4-0000-4000-8000-000000000002';

function credentialBody(clientSecret = 'secret-1', rotatedAt: string | null = null): unknown {
  return {
    credential: {
      renderer_id: RENDERER_ID,
      credential_id: CREDENTIAL_ID,
      installation_name: 'Local video renderer',
      status: 'active',
      created_at: '2026-09-07T00:00:00Z',
      rotated_at: rotatedAt,
      expires_at: '2026-12-07T00:00:00Z',
      last_used_at: null,
    },
    client_secret: clientSecret,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** BFF that requires the cookie + CSRF browser session, which is what dev enforces today. */
function cookieOnlyBff(options: { sessionStatus?: number } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)
      .map(([key, value]) => [key.toLowerCase(), value]));
    calls.push({ url, headers });
    if (url === `${BFF}/bff/v1/session`) {
      if (options.sessionStatus) return json({ detail: 'no' }, options.sessionStatus);
      if (headers.authorization !== 'Bearer access-1') return json({ detail: 'no' }, 401);
      const response = json({ user_id: 'u', csrf_token: 'csrf-1' });
      response.headers.append('Set-Cookie', 'user_auth=session-token; HttpOnly; Path=/');
      response.headers.append('Set-Cookie', 'storykernel_csrf=csrf-1; Path=/');
      return response;
    }
    if (!headers.cookie || headers['x-csrf-token'] !== 'csrf-1') return json({ detail: 'CSRF proof required' }, 403);
    if (url.endsWith('/rotate')) return json(credentialBody('secret-2', '2026-09-08T00:00:00Z'));
    return json(credentialBody(), 201);
  };
  return { impl, calls };
}

/** BFF that accepts the OAuth bearer directly, which is what PIC-1739 delivers. */
function bearerBff() {
  const calls: string[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.Authorization !== 'Bearer access-1') return json({ detail: 'no' }, 401);
    return json(credentialBody(), 201);
  };
  return { impl, calls };
}

describe('minted credential parsing', () => {
  it('reads the renderer identity and secret out of the BFF response', () => {
    expect(parseMintedCredential(credentialBody())).toMatchObject({
      rendererId: RENDERER_ID, credentialId: CREDENTIAL_ID, clientSecret: 'secret-1', installationName: 'Local video renderer',
    });
  });

  it('refuses a response with no client secret or a malformed identity', () => {
    expect(() => parseMintedCredential({ credential: { renderer_id: RENDERER_ID, credential_id: CREDENTIAL_ID } })).toThrow(/client secret/);
    expect(() => parseMintedCredential({ credential: { renderer_id: 'nope', credential_id: CREDENTIAL_ID }, client_secret: 's' })).toThrow(/malformed/);
  });

  it('keeps the client secret out of the page-facing status', () => {
    const status = credentialStatus({
      environment: 'dev', rendererId: RENDERER_ID, credentialId: CREDENTIAL_ID, clientSecret: 'secret-1',
      installationName: 'Local video renderer', adapter: 'bearer', createdAt: '', rotatedAt: null, expiresAt: null,
    });
    expect(JSON.stringify(status)).not.toContain('secret-1');
    expect(status).toMatchObject({ present: true, rendererId: RENDERER_ID, adapter: 'bearer' });
  });
});

describe('browser-session fallback', () => {
  it('builds the cookie header and CSRF proof from the session response', () => {
    const session = browserSessionFrom(['user_auth=abc; HttpOnly; Path=/', 'storykernel_csrf=csrf-1; Path=/'], { csrf_token: 'csrf-1' });
    expect(session.cookieHeader).toBe('user_auth=abc; storykernel_csrf=csrf-1');
    expect(session.csrfToken).toBe('csrf-1');
  });

  it('refuses a CSRF cookie that does not match the returned token', () => {
    expect(() => browserSessionFrom(['storykernel_csrf=other; Path=/'], { csrf_token: 'csrf-1' })).toThrow(/mismatched/);
  });
});

describe('mint and rotate', () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'renderer-credential-'));
    env = { RENDERER_STATE_DIR: join(directory, '.renderer') };
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('uses the bearer adapter when the BFF accepts the OAuth token', async () => {
    const bff = bearerBff();
    const credential = await mintRendererCredential({ bffBaseUrl: BFF, accessToken: 'access-1', environment: 'dev', fetchImpl: bff.impl, env });
    expect(credential.adapter).toBe('bearer');
    expect(bff.calls).toEqual([`${BFF}/bff/v1/developer/renderers`]);
    expect(statSync(privatePath('credential.json', env)).mode & 0o777).toBe(0o600);
    expect(readStoredCredential(env)?.clientSecret).toBe('secret-1');
  });

  it('falls back to the cookie + CSRF session the BFF requires today', async () => {
    const bff = cookieOnlyBff();
    const credential = await mintRendererCredential({ bffBaseUrl: BFF, accessToken: 'access-1', environment: 'dev', fetchImpl: bff.impl, env });
    expect(credential.adapter).toBe('browser-session');
    expect(bff.calls.map(call => call.url)).toEqual([
      `${BFF}/bff/v1/developer/renderers`,
      `${BFF}/bff/v1/session`,
      `${BFF}/bff/v1/developer/renderers`,
    ]);
    expect(bff.calls.at(-1)?.headers['x-csrf-token']).toBe('csrf-1');
  });

  it('rotates in place and replaces the stored secret', async () => {
    const bff = cookieOnlyBff();
    const minted = await mintRendererCredential({ bffBaseUrl: BFF, accessToken: 'access-1', environment: 'dev', fetchImpl: bff.impl, env });
    const rotated = await rotateRendererCredential({ bffBaseUrl: BFF, accessToken: 'access-1', credential: minted, fetchImpl: bff.impl, env });
    expect(bff.calls.at(-1)?.url).toBe(`${BFF}/bff/v1/developer/renderers/${RENDERER_ID}/rotate`);
    expect(rotated.clientSecret).toBe('secret-2');
    expect(readStoredCredential(env)?.clientSecret).toBe('secret-2');
  });

  it('explains an unaccepted sign-in instead of leaking the HTTP detail', async () => {
    const bff = cookieOnlyBff({ sessionStatus: 401 });
    await expect(mintRendererCredential({ bffBaseUrl: BFF, accessToken: 'access-1', environment: 'dev', fetchImpl: bff.impl, env }))
      .rejects.toThrow(/PIC-1739/);
  });

  it('surfaces the developer rate limit as a retryable message', async () => {
    const impl = async (url: string): Promise<Response> => (url.endsWith('/session')
      ? json({ csrf_token: 'csrf-1' }, 200, { 'Set-Cookie': 'storykernel_csrf=csrf-1' })
      : json({ detail: 'slow down' }, 429));
    await expect(mintRendererCredential({ bffBaseUrl: BFF, accessToken: 'access-1', environment: 'dev', fetchImpl: impl, env }))
      .rejects.toThrow(/rate limited/);
  });
});

describe('fence detection', () => {
  it('recognises the failures that mean the credential must be rotated', () => {
    expect(credentialFenced(['renderer bridge closed: 401 unauthorized'])).toBe(true);
    expect(credentialFenced(['this renderer was fenced by a newer connection'])).toBe(true);
    expect(credentialFenced(['invalid_client'])).toBe(true);
    expect(credentialFenced(['fal generation failed after 3 attempts'])).toBe(false);
    expect(credentialFenced([])).toBe(false);
  });
});
