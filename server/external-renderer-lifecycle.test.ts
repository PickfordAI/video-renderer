import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { ExternalRendererRunManager } from './external-renderer.js';
import type { PlayoutManager } from './playout.js';
import { generateVideo } from './fal.js';
vi.mock('./fal.js', () => ({ generateVideo: vi.fn(async () => ({ videoUrl: 'https://video.example/clip.mp4' })) }));
const rendererId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storyChannel = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function config(baseUrl = 'http://127.0.0.1:9999') {
  return { baseUrl, rendererId, credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', clientSecret: 'test-installation', rendererVersion: 'h3.test.v1.0', environment: 'local', storyId: 42, roomId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', roomShortlink: 'TEST', storyMessageChannelId: storyChannel, roomMainMessageChannelId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', storyConfig: { base_structure: 'MINIMAX', evd_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', message_channel_ids: [storyChannel] } };
}
function playout() {
  const enqueue = vi.fn();
  const stop = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({ sessionId: 'session', hlsUrl: 'https://media.example/index.m3u8', enqueue, status: () => ({ state: 'streaming', playedThroughPosition: 99 }) }));
  return { manager: { start, stop } as unknown as PlayoutManager, start, stop, enqueue };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('external renderer lifecycle', () => {
  it('renders a bridge assignment, acknowledges playback, and sends no synthetic audience messages', async () => {
    vi.stubEnv('FAL_KEY', 'test-fal');
    const http = createServer();
    const ws = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    const frames: Record<string, unknown>[] = [];
    ws.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      if (frame.type === 'renderer.hello') socket.send(JSON.stringify({ type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null, session_id: 'session', session_epoch: 1, lease_seconds: 30 }));
      if (frame.type === 'renderer.asset_manifest') socket.send(JSON.stringify({ type: 'renderer.asset_manifest.accepted', sha256: frame.sha256 }));
    }));
    const fetchMock = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).endsWith('/login')) {
        expect(JSON.parse(String(options?.body))).toMatchObject({ tier: 'renderer-dev', environment: 'local' });
        return Response.json({ access_token: 'test-token', websocket_url: `ws://127.0.0.1:${port}` });
      }
      for (const socket of ws.clients) socket.send(JSON.stringify({ stream_id: rendererId, assignment_id: 'assignment', assignment_generation: 1, sequence: 1, story_block_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', script: { sequence: 1, command_groups: [{ id: 'group', commands: [{ command: 'Talk', args: { character: 'Alex', dialogue: 'Hello Sam.' } }] }] } }));
      return Response.json({ renderer_id: rendererId, audience_grant: { grant: { story_id: 42, message_channel_id: storyChannel } } }, { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const media = playout();
    const manager = new ExternalRendererRunManager(media.manager);
    const run = manager.start(config(`http://127.0.0.1:${port}`));
    try {
      await vi.waitFor(() => expect(run.dssCommandsRendered).toBe(1));
      expect(generateVideo).toHaveBeenCalledTimes(1);
      expect(media.enqueue).toHaveBeenCalledTimes(1);
      expect(frames.some(f => f.type === 'renderer.event' && f.event === 'completed' && f.id === 6)).toBe(true);
      expect(frames.some(f => String(f.type).startsWith('audience.'))).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(() => manager.start(config())).toThrow('already active');
    } finally {
      await manager.stopAll();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
    expect(media.stop).toHaveBeenCalledTimes(1);
    expect(run.state).toBe('stopped');
  });
  it('releases playout after failed login and redacts known secrets', async () => {
    vi.stubEnv('FAL_KEY', 'test-fal');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ detail: 'test-installation test-fal' }, { status: 401 })));
    const media = playout();
    const manager = new ExternalRendererRunManager(media.manager);
    const run = manager.start(config());
    await vi.waitFor(() => expect(media.stop).toHaveBeenCalledTimes(1));
    expect(run.state).toBe('failed');
    expect(JSON.stringify(run)).not.toContain('test-installation');
    expect(JSON.stringify(run)).not.toContain('test-fal');
  });
  it('aborts a login in progress when stopped', async () => {
    vi.stubEnv('FAL_KEY', 'test-fal');
    let loginSignal: AbortSignal | null = null;
    vi.stubGlobal('fetch', vi.fn((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
      loginSignal = options.signal as AbortSignal;
      loginSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    const media = playout();
    const manager = new ExternalRendererRunManager(media.manager);
    const run = manager.start(config());
    await vi.waitFor(() => expect(loginSignal).not.toBeNull());
    await manager.stop(run.runId);
    expect((loginSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(media.stop).toHaveBeenCalledTimes(1);
    expect(run.state).toBe('stopped');
  });
});
