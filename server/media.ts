import { servePublicViewer } from './public-viewer.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PlayoutManager } from './playout.js';
import type { AudienceChatGateway } from './audience-chat.js';
import type { CreatorApi } from './creator-api.js';

function isSameOriginLocalViewer(request: IncomingMessage): boolean {
  try {
    const host = new URL(`http://${request.headers.host ?? ''}`).hostname;
    const source = request.headers.origin ?? request.headers.referer;
    const origin = source ? new URL(source) : null;
    return ['localhost', '127.0.0.1', '[::1]'].includes(host)
      && request.headers['sec-fetch-site'] === 'same-origin'
      // The viewer itself sends Referrer-Policy: no-referrer, and browsers do not
      // normally add Origin to same-origin GETs. The listener binding and Host
      // check provide the local boundary; validate source only when one exists.
      && (origin === null || ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));
  } catch {
    return false;
  }
}

export function mediaPath(pathname: string): { sessionId: string; relayPath: string } | null {
  const match = pathname.match(/^\/hls\/h3-([0-9a-f-]{36})\/([a-zA-Z0-9_-]+\.(?:m3u8|mp4|m4s|ts))$/);
  return match ? { sessionId: match[1], relayPath: `/h3-${match[1]}/${match[2]}` } : null;
}

export async function serveMedia(
  request: IncomingMessage,
  response: ServerResponse,
  manager: PlayoutManager,
  viewerRoot?: string,
  audienceChat?: AudienceChatGateway,
  localViewerStatus?: () => unknown,
  creatorApi?: CreatorApi,
): Promise<void> {
  if (audienceChat && await audienceChat.handle(request, response)) return;
  // The creator surface is handled before the permissive media CORS header is applied; it enforces
  // its own same-origin local boundary and must never be readable cross-origin.
  if (creatorApi && await creatorApi.handle(request, response)) return;
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(request.url ?? '/', 'http://local');
  if (localViewerStatus && url.pathname === '/api/viewer-status' && request.method === 'GET' && isSameOriginLocalViewer(request)) {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(localViewerStatus()));
    return;
  }
  if (url.pathname === '/healthz' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  if (await servePublicViewer(request, response, viewerRoot)) return;
  const path = mediaPath(url.pathname);
  if (!path || !['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(404); response.end(); return; }
  const session = manager.get(path.sessionId);
  if (!session || ['stopped', 'error'].includes(session.status().state)) { response.writeHead(404); response.end(); return; }
  const controller = new AbortController();
  response.once('close', () => controller.abort());
  try {
    const base = process.env.MEDIA_RELAY_HLS_BASE_URL || 'http://127.0.0.1:8888';
    const upstream = await fetch(`${base.replace(/\/$/, '')}${path.relayPath}${url.search}`, {
      method: request.method, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    });
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' });
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as never), response);
    else response.end();
  } catch {
    if (!response.headersSent) response.writeHead(502);
    if (!response.destroyed) response.end();
  }
}
