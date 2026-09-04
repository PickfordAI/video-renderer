import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function allowOperatorRequest(request: IncomingMessage, token = process.env.RENDERER_ADMIN_TOKEN): boolean {
  if (token) {
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const a = Buffer.from(supplied);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  // The local/Compose operator port must only be published on loopback. Validate
  // Host and Origin as well, so a website cannot use DNS rebinding or CSRF to spend fal credits.
  const host = request.headers.host ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  if (request.headers['x-forwarded-for'] || request.headers['forwarded']) return false;
  if (request.headers.origin && request.headers.origin !== `http://${host}`) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}
