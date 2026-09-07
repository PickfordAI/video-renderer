import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { serveMedia } from './media.js';
import { viewerFile } from './public-viewer.js';
import type { PlayoutManager } from './playout.js';

describe('combined public viewer and stream listener', () => {
  it('has no static fallback for private routes or traversal', () => {
    expect(viewerFile('/')).toBe('index.html');
    expect(viewerFile('/assets/index-aBc123.js')).toBe('assets/index-aBc123.js');
    for (const path of ['/external-run.html', '/api/health', '/server/index.ts', '/.env', '/assets/../index.html', '/assets/%2e%2e/secret.js', '/assets/source.js.map']) expect(viewerFile(path)).toBeNull();
  });
  it('serves the built viewer and its assets on the public listener while blocking operator paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'public-viewer-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<h1>Public viewer</h1>');
    await writeFile(join(root, 'assets/player.js'), '/* public player */');
    await writeFile(join(root, 'external-run.html'), 'private operator');
    const manager = { get: () => null } as unknown as PlayoutManager;
    const server = createServer((req, res) => void serveMedia(req, res, manager, root));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const page = await fetch(base);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await page.text()).toContain('Public viewer');
      const head = await fetch(base, { method: 'HEAD' });
      expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0);
      expect(await head.text()).toBe('');
      const script = await fetch(`${base}/assets/player.js`);
      expect(script.headers.get('content-type')).toContain('text/javascript');
      expect(await script.text()).toContain('public player');
      for (const route of ['/api/health', '/api/viewer-status', '/api/generate', '/external-run.html', '/.env', '/server/index.ts']) expect((await fetch(base + route)).status).toBe(404);
      expect((await fetch(base, { method: 'POST' })).status).toBe(404);
      expect((await fetch(base + '/healthz')).status).toBe(200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  it('can expose the allowlisted playback status on an explicitly local-only listener', async () => {
    const manager = { get: () => null } as unknown as PlayoutManager;
    const status = { setup: { ready: true, missing: [] }, story: { state: 'running', hlsUrl: 'http://127.0.0.1:4174/hls/example/index.m3u8' } };
    const server = createServer((req, res) => void serveMedia(req, res, manager, undefined, undefined, () => status));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const response = await fetch(`${base}/api/viewer-status`, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(status);
      expect((await fetch(`${base}/api/viewer-status`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
      expect((await fetch(`${base}/api/viewer-status`, { headers: { Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(404);
      expect((await fetch(`${base}/api/viewer-status`, { method: 'POST' })).status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
