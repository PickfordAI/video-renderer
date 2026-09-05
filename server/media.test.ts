import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaPath, serveMedia } from './media.js';
import type { PlayoutManager } from './playout.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
afterEach(() => vi.unstubAllGlobals());
describe('read-only media gateway', () => {
  it('accepts only HLS resources and no traversal, operator routes, or arbitrary origins', () => {
    expect(mediaPath(`/hls/h3-${id}/index.m3u8`)).toMatchObject({ sessionId: id });
    for (const path of ['/api/generate', '/api/external-renderer/runs', `/hls/h3-${id}/../secret`, `/hls/h3-${id}/%2e%2e`, '/https://example.com/a.mp4', `/hls/h3-${id}/index.html`]) expect(mediaPath(path)).toBeNull();
  });
  it('serves live sessions, rejects stopped sessions and never forwards operator requests', async () => {
    let state = 'streaming';
    const manager = { get: (key: string) => key === id ? { status: () => ({ state }) } : null } as unknown as PlayoutManager;
    const originalFetch = globalThis.fetch;
    const upstream = vi.fn(async () => new Response('#EXTM3U\nstream.m3u8', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }));
    vi.stubGlobal('fetch', upstream);
    const server = createServer((req, res) => void serveMedia(req, res, manager));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const base = `http://127.0.0.1:${port}`;
      const response = await originalFetch(`${base}/hls/h3-${id}/index.m3u8`);
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(await response.text()).toContain('#EXTM3U');
      expect((await originalFetch(`${base}/api/generate`, { method: 'POST' })).status).toBe(404);
      expect((await originalFetch(`${base}/hls/h3-${id}/index.m3u8`, { method: 'DELETE' })).status).toBe(404);
      state = 'stopped';
      expect((await originalFetch(`${base}/hls/h3-${id}/index.m3u8`)).status).toBe(404);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
