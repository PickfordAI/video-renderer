/**
 * Where a signed-in creator's Pickford environment lives.
 *
 * In production, the API origin (`api.pickford.ai`) serves Identity, its OAuth authorization
 * server and the hosted MCP, the frontend origin (`pickford.ai`) serves `/bff/v1/*` and
 * `/api/v1/renderers/*`, and the chat origin (`chat.pickford.ai`) serves the public audience
 * exchange. Developers can explicitly override those separate origins for another environment.
 */

export type PickfordEnvironmentName = 'local' | 'test' | 'dev' | 'edge' | 'staging' | 'creator' | 'prod' | 'demo';

export const PICKFORD_ENVIRONMENTS: readonly PickfordEnvironmentName[] = [
  'local', 'test', 'dev', 'edge', 'staging', 'creator', 'prod', 'demo',
];

export const DEFAULT_PICKFORD_ENVIRONMENT: PickfordEnvironmentName = 'prod';

export interface PickfordEnvironment {
  /** Environment name, also sent to the renderer bridge as `environment`. */
  name: PickfordEnvironmentName;
  /** Identity, OAuth and the hosted MCP. */
  apiBaseUrl: string;
  /** Browser origin that serves `/bff/v1/*`. */
  webBaseUrl: string;
  /** Renderer login/start origin; defaults to the browser origin. */
  rendererPlatformBaseUrl: string;
  /** Chat origin that serves `/api/v1/external-audience/exchange`. */
  chatBaseUrl: string;
  /** OAuth resource (audience) the renderer requests tokens for. */
  oauthResource: string;
  /** The scope that belongs to that resource. Identity rejects any other pairing. */
  oauthScope: string;
}

export const RENDERER_SCOPE = 'storykernel:renderer';
export const ONBOARDING_SCOPE = 'storykernel:onboarding';

/**
 * Resource and scope are a fixed pair on Identity (PIC-1739): asking for the renderer resource
 * with the onboarding scope, or the reverse, fails with `invalid_scope`. Deriving the scope from
 * the resource means an override of one cannot silently break the other.
 */
export function scopeForResource(resource: string): string {
  const path = new URL(resource).pathname.replace(/\/$/, '');
  if (path.endsWith('/storykernel/mcp')) return ONBOARDING_SCOPE;
  return RENDERER_SCOPE;
}

function origin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain credentials, a query, or a fragment.`);
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`${label} must use HTTPS, or HTTP on a loopback host.`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
}

export function environmentName(value: string | undefined): PickfordEnvironmentName {
  const name = (value ?? '').trim() || DEFAULT_PICKFORD_ENVIRONMENT;
  if (!PICKFORD_ENVIRONMENTS.includes(name as PickfordEnvironmentName)) {
    throw new Error(`STORY_ENVIRONMENT must be one of ${PICKFORD_ENVIRONMENTS.join(', ')}.`);
  }
  return name as PickfordEnvironmentName;
}

function defaultHosts(name: PickfordEnvironmentName): { apiBaseUrl: string; webBaseUrl: string; chatBaseUrl: string } {
  if (name === 'local' || name === 'test') {
    return {
      apiBaseUrl: 'http://127.0.0.1:8081',
      webBaseUrl: 'http://127.0.0.1:5173',
      chatBaseUrl: 'http://127.0.0.1:8080',
    };
  }
  return {
    apiBaseUrl: 'https://api.pickford.ai',
    webBaseUrl: 'https://pickford.ai',
    chatBaseUrl: 'https://chat.pickford.ai',
  };
}

/**
 * `STORY_ENVIRONMENT` selects the environment. `PICKFORD_API_URL`, `PICKFORD_WEB_URL`,
 * `CHAT_BACKEND_URL`, `RENDERER_PLATFORM_URL`, `PICKFORD_OAUTH_RESOURCE` and
 * `PICKFORD_OAUTH_SCOPE` override individual values for one-off or self-hosted kernels.
 */
export function pickfordEnvironment(env: NodeJS.ProcessEnv = process.env): PickfordEnvironment {
  const name = environmentName(env.STORY_ENVIRONMENT);
  const defaults = defaultHosts(name);
  if (name !== 'local' && name !== 'test' && name !== 'prod') {
    for (const key of ['PICKFORD_API_URL', 'PICKFORD_WEB_URL', 'CHAT_BACKEND_URL'] as const) {
      if (!env[key]?.trim()) throw new Error(`${key} is required when STORY_ENVIRONMENT=${name}.`);
    }
  }
  const apiBaseUrl = origin(env.PICKFORD_API_URL || defaults.apiBaseUrl, 'PICKFORD_API_URL');
  const webBaseUrl = origin(env.PICKFORD_WEB_URL || defaults.webBaseUrl, 'PICKFORD_WEB_URL');
  const rendererPlatformBaseUrl = origin(env.RENDERER_PLATFORM_URL || webBaseUrl, 'RENDERER_PLATFORM_URL');
  const chatBaseUrl = origin(env.CHAT_BACKEND_URL || defaults.chatBaseUrl, 'CHAT_BACKEND_URL');
  // The renderer has its own resource (PIC-1739), separate from the hosted MCP's.
  // Local web-endpoints proxies discovery on :8081, but Identity is the canonical resource
  // server and advertises :8090. Request that exact resource so RFC 9728 validation succeeds.
  const defaultOauthResource = name === 'local' || name === 'test'
    ? 'http://localhost:8090/renderer'
    : `${apiBaseUrl}/renderer`;
  const oauthResource = origin(env.PICKFORD_OAUTH_RESOURCE || defaultOauthResource, 'PICKFORD_OAUTH_RESOURCE');
  const oauthScope = env.PICKFORD_OAUTH_SCOPE?.trim() || scopeForResource(oauthResource);
  return { name, apiBaseUrl, webBaseUrl, rendererPlatformBaseUrl, chatBaseUrl, oauthResource, oauthScope };
}
