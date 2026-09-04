# Security

Please report vulnerabilities through the repository's GitHub **Security → Report a vulnerability**
feature when enabled. If private reporting is unavailable, contact a repository maintainer privately
through their GitHub profile. Do not open a public issue containing credentials or exploit details.

Include affected versions, reproduction steps, and impact, with secrets removed. The latest `main`
branch is the supported version during this early release.

The operator API can submit paid generation jobs and make authenticated kernel requests. Bind it
to loopback locally. Hosted deployments require RENDERER_ADMIN_TOKEN and private network access;
only the separate media port is internet-facing. Watch URLs are capabilities: anyone with the URL
can watch until the session stops. This is a single-owner worker, not a multi-tenant hosted service.

Do not expose the studio's proxy endpoints or MediaMTX ingest/admin ports through a public reverse
proxy. Browser storage is not a secret vault; the studio uses sessionStorage for its local token.
Prefer the agent handoff workflow for credential-based renderer sessions. Delete/rotate secrets
through the issuer when a machine or handoff file is compromised.
