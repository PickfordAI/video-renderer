export interface RendererToken {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  renderer: { renderer_id: string; bridge_url: string; session_generation: number };
}

type Body = Record<string, unknown>;

export async function v1AuthRequest(baseUrl: string, path: string, body: Body, signal?: AbortSignal): Promise<Body> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  let payload: Body;
  try {
    const value = await response.json();
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    payload = value as Body;
  } catch { throw new Error(`V1 sign-in returned malformed JSON (${response.status})`); }
  if (!response.ok) {
    const rawCode = typeof payload.code === 'string' ? payload.code : typeof payload.error === 'string' ? payload.error : '';
    const code = /^[a-z_]{1,64}$/.test(rawCode) ? rawCode : 'unavailable';
    // Error text is deliberately status/code only; servers may echo credential fields.
    throw Object.assign(new Error(`V1 sign-in failed (${response.status}, ${code})`), {
      code, retryAfter: Number(payload.retry_after_seconds ?? 0),
    });
  }
  return payload;
}

export function rendererToken(payload: Body, expectedRendererId?: string): RendererToken {
  const descriptor = payload.renderer as RendererToken['renderer'] | undefined;
  if (!descriptor || typeof descriptor.renderer_id !== 'string' || typeof descriptor.bridge_url !== 'string'
      || !Number.isInteger(descriptor.session_generation) || descriptor.session_generation < 0
      || typeof payload.access_token !== 'string' || !payload.access_token
      || !Number.isFinite(payload.expires_in) || Number(payload.expires_in) <= 0
      || !String(payload.scope ?? '').split(' ').includes('renderer.connect')) {
    throw new Error('V1 sign-in did not return a renderer connection grant');
  }
  if (expectedRendererId && descriptor.renderer_id !== expectedRendererId) throw new Error('V1 sign-in returned another renderer');
  const bridge = new URL(descriptor.bridge_url);
  if (bridge.pathname !== '/v1/renderers/bridge' || bridge.search || bridge.hash) throw new Error('Invalid V1 renderer bridge URL');
  return payload as unknown as RendererToken;
}

export async function mintRendererToken(baseUrl: string, grant: Body, expectedRendererId?: string, signal?: AbortSignal): Promise<RendererToken> {
  return rendererToken(await v1AuthRequest(baseUrl, '/v1/auth/token', grant, signal), expectedRendererId);
}
