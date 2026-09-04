import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../dist/viewer/', import.meta.url));

export function viewerFile(pathname: string): string | null {
  if (pathname === '/' || pathname === '/index.html') return 'index.html';
  if (/^\/assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(pathname)) return pathname.slice(1);
  if (/^\/licenses\/[A-Za-z0-9_.-]+\.txt$/.test(pathname)) return pathname.slice(1);
  return null;
}

export async function servePublicViewer(request: IncomingMessage, response: ServerResponse, root = defaultRoot): Promise<boolean> {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) return false;
  const file = viewerFile(new URL(request.url ?? '/', 'http://local').pathname);
  if (!file) return false;
  try {
    const body = await readFile(join(root, file));
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/plain';
    response.writeHead(200, {
      'Content-Type': `${type}; charset=utf-8`,
      'Content-Length': body.length,
      'Cache-Control': file.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404);
    response.end();
  }
  return true;
}
