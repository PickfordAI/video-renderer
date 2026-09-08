/**
 * RFC 9728 protected-resource discovery and RFC 8414 authorization-server discovery.
 *
 * Pickford publishes both today: the hosted MCP answers 401 with
 * `WWW-Authenticate: Bearer ..., resource_metadata="…/.well-known/oauth-protected-resource"`, and
 * the renderer resource added by PIC-1739 publishes the same documents. Nothing here is
 * hard-coded to a route, so a renamed resource is a metadata change rather than a code change.
 */

export interface ProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string | null;
  scopesSupported: string[];
  codeChallengeMethodsSupported: string[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DISCOVERY_TIMEOUT_MS = 15_000;

function secureUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is missing from the Pickford metadata.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password) throw new Error(`${label} must not embed credentials.`);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`${label} must use HTTPS, or HTTP on a loopback host.`);
  }
  return parsed.toString();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Reads `resource_metadata` out of a `WWW-Authenticate` challenge, if the server supplied one. */
export function resourceMetadataFromChallenge(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = header.match(/resource_metadata\s*=\s*"([^"]+)"/i) ?? header.match(/resource_metadata\s*=\s*([^,\s]+)/i);
  if (!match) return null;
  try {
    return secureUrl(match[1], 'resource_metadata');
  } catch {
    return null;
  }
}

/**
 * Candidate metadata locations for a resource, in the order RFC 9728 prefers: the path-inserted
 * form first, then the path-appended form Pickford also serves, then the bare origin.
 */
export function resourceMetadataUrls(resource: string): string[] {
  const url = new URL(secureUrl(resource, 'resource'));
  const path = url.pathname.replace(/\/$/, '');
  const candidates = [
    `${url.origin}/.well-known/oauth-protected-resource${path}`,
    `${url.origin}${path}/.well-known/oauth-protected-resource`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
  return [...new Set(candidates)];
}

/** Candidate authorization-server metadata locations for an issuer with a path component. */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(secureUrl(issuer, 'issuer'));
  const path = url.pathname.replace(/\/$/, '');
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/oauth-authorization-server`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
  return [...new Set(candidates)];
}

/** Compares two resource identifiers the way RFC 9728 does: exact, bar a trailing slash. */
export function sameResource(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  };
  try {
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

async function fetchJson(
  urls: string[],
  fetchImpl: FetchLike,
  label: string,
  accept: (body: Record<string, unknown>) => string | null = () => null,
): Promise<Record<string, unknown>> {
  const problems: string[] = [];
  for (const url of urls) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
    } catch (error) {
      problems.push(`${url}: ${error instanceof Error ? error.message : 'request failed'}`);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      problems.push(`${url}: HTTP ${response.status}`);
      continue;
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      problems.push(`${url}: response was not JSON`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`${url}: metadata was not an object`);
      continue;
    }
    const rejection = accept(value as Record<string, unknown>);
    if (rejection) {
      problems.push(`${url}: ${rejection}`);
      continue;
    }
    return value as Record<string, unknown>;
  }
  throw new Error(`Could not read ${label} from Pickford (${problems.join('; ')}).`);
}

export async function discoverProtectedResource(
  resource: string,
  fetchImpl: FetchLike,
  extraUrls: readonly string[] = [],
): Promise<ProtectedResourceMetadata> {
  // A candidate that describes some *other* resource must be rejected, not adopted. An origin can
  // serve several protected resources (Pickford's bare-origin document describes the hosted MCP),
  // and silently accepting one would bind the renderer's tokens to the wrong audience and scope.
  const body = await fetchJson(
    [...extraUrls, ...resourceMetadataUrls(resource)],
    fetchImpl,
    'the resource metadata',
    (value) => {
      const declared = typeof value.resource === 'string' ? value.resource : null;
      if (!declared) return 'metadata declared no resource';
      return sameResource(declared, resource) ? null : `metadata describes ${declared}, not the requested resource`;
    },
  );
  const authorizationServers = stringList(body.authorization_servers).map(value => secureUrl(value, 'authorization_servers[]'));
  if (!authorizationServers.length) throw new Error('The Pickford resource metadata lists no authorization server.');
  return {
    resource: secureUrl(body.resource ?? resource, 'resource'),
    authorizationServers,
    scopesSupported: stringList(body.scopes_supported),
  };
}

export async function discoverAuthorizationServer(issuer: string, fetchImpl: FetchLike): Promise<AuthorizationServerMetadata> {
  const body = await fetchJson(authorizationServerMetadataUrls(issuer), fetchImpl, 'the authorization-server metadata');
  const metadata: AuthorizationServerMetadata = {
    issuer: secureUrl(body.issuer ?? issuer, 'issuer'),
    authorizationEndpoint: secureUrl(body.authorization_endpoint, 'authorization_endpoint'),
    tokenEndpoint: secureUrl(body.token_endpoint, 'token_endpoint'),
    registrationEndpoint: secureUrl(body.registration_endpoint, 'registration_endpoint'),
    revocationEndpoint: body.revocation_endpoint === undefined ? null : secureUrl(body.revocation_endpoint, 'revocation_endpoint'),
    scopesSupported: stringList(body.scopes_supported),
    codeChallengeMethodsSupported: stringList(body.code_challenge_methods_supported),
  };
  if (metadata.codeChallengeMethodsSupported.length && !metadata.codeChallengeMethodsSupported.includes('S256')) {
    throw new Error('Pickford must support the S256 PKCE method; the renderer never sends a plain verifier.');
  }
  if (new URL(metadata.issuer).origin !== new URL(issuer).origin) {
    throw new Error('The Pickford authorization-server metadata was served by a different origin.');
  }
  return metadata;
}
