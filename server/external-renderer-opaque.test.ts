import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { AUDIENCE_EXCHANGE_PATH, ExternalRendererRunManager, parseExternalRendererRunConfig } from './external-renderer.js';
import type { PlayoutManager } from './playout.js';
import { generateVideo } from './fal.js';
vi.mock('./fal.js', () => ({ generateVideo: vi.fn(async () => ({ videoUrl: 'https://video.example/clip.mp4' })) }));
const rendererId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const evdId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const storyRunId = '11111111-1111-4111-8111-111111111111';
const storyChannel = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const config = (baseUrl = 'http://127.0.0.1:9999') => ({ baseUrl, rendererId, credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', clientSecret: 'test-installation', rendererVersion: 'h3.test.v1.0', environment: 'local', startMode: 'opaque', evdId });
function playout() {
  const enqueue = vi.fn();
  const stop = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({ sessionId: 'session', hlsUrl: 'https://media.example/index.m3u8', enqueue, status: () => ({ state: 'streaming', playedThroughPosition: 99 }) }));
  return { manager: { start, stop } as unknown as PlayoutManager, start, stop, enqueue };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('opaque run configuration', () => {
  it('needs only the EVD in opaque mode and keeps the legacy story requirement otherwise', () => {
    const parsed = parseExternalRendererRunConfig(config());
    expect(parsed).toMatchObject({ startMode: 'opaque', evdId, storyId: null, audienceExchangeUrl: null, supersedeExistingStory: false });
    expect(parseExternalRendererRunConfig({ ...config(), audienceExchangeUrl: 'http://127.0.0.1:8080/api/v1/external-audience/exchange' }).audienceExchangeUrl).toBe('http://127.0.0.1:8080/api/v1/external-audience/exchange');
    expect(parseExternalRendererRunConfig({ ...config(), supersedeExistingStory: true }).supersedeExistingStory).toBe(true);
    expect(() => parseExternalRendererRunConfig({ ...config(), supersedeExistingStory: 'yes' })).toThrow('supersedeExistingStory must be boolean');
    expect(() => parseExternalRendererRunConfig({ ...config(), evdId: undefined })).toThrow('evdId is required');
    expect(() => parseExternalRendererRunConfig({ ...config(), startMode: 'magic' })).toThrow('startMode must be legacy or opaque');
    const legacy = { ...config(), startMode: undefined, evdId: undefined };
    expect(parseExternalRendererRunConfig(legacy)).toMatchObject({ startMode: 'legacy', storyId: 1, evdId: null });
    expect(() => parseExternalRendererRunConfig({ ...legacy, supersedeExistingStory: true })).toThrow('supersedeExistingStory requires opaque start mode');
    expect(() => parseExternalRendererRunConfig({ ...legacy, storyId: 0 })).toThrow('storyId must be a positive integer');
  });
});

describe('opaque renderer-initiated story start', () => {
  it.each([
    { exchange: 'kernel origin', explicitExchange: false, recoverStart: false, recoverExchange: false, supersedeExisting: false },
    { exchange: 'configured chat service', explicitExchange: true, recoverStart: false, recoverExchange: false, supersedeExisting: false },
    { exchange: 'kernel origin after gateway timeout', explicitExchange: false, recoverStart: true, recoverExchange: false, supersedeExisting: false },
    { exchange: 'kernel origin after transient exchange failure', explicitExchange: false, recoverStart: false, recoverExchange: true, supersedeExisting: false },
    { exchange: 'kernel origin while superseding the prior renderer story', explicitExchange: false, recoverStart: false, recoverExchange: false, supersedeExisting: true },
  ])('starts from the EVD, resolves the story through the audience exchange at the $exchange, and relays audience chat to it', async ({ explicitExchange, recoverStart, recoverExchange, supersedeExisting }) => {
    vi.stubEnv('FAL_KEY', 'test-fal');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const http = createServer();
    const ws = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    const exchangeUrl = explicitExchange ? 'http://127.0.0.1:8080/api/v1/external-audience/exchange' : `http://127.0.0.1:${port}${AUDIENCE_EXCHANGE_PATH}`;
    const frames: Record<string, unknown>[] = [];
    ws.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      if (frame.type === 'renderer.hello') socket.send(JSON.stringify({ type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null, session_id: 'session', session_epoch: 1, lease_seconds: recoverStart || recoverExchange ? 4 : 30 }));
      if (frame.type === 'renderer.asset_manifest') socket.send(JSON.stringify({ type: 'renderer.asset_manifest.accepted', sha256: frame.sha256 }));
      if (frame.type === 'audience.message') socket.send(JSON.stringify({ type: 'audience.message.accepted', source_message_id: frame.message_id, message_id: 'kernel-message-1' }));
    }));
    const startBodies: unknown[] = [];
    const exchangeRequests: Array<{ url: string; origin: string | undefined; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/login')) return Response.json({ access_token: 'test-token', websocket_url: `ws://127.0.0.1:${port}` });
      if (target.endsWith('/api/v1/renderers/start-story')) {
        startBodies.push(JSON.parse(String(options?.body)));
        expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-token');
        if (recoverStart && startBodies.length === 1) return Response.json({ detail: 'upstream timed out' }, { status: 502 });
        return Response.json({ story_run_id: storyRunId, audience_join_url: 'http://audience.example:3000/audience/opaque-handle-1234567890', status: 'audience_ready' }, { status: 202 });
      }
      if (target === exchangeUrl) {
        exchangeRequests.push({ url: target, origin: new Headers(options?.headers).get('origin') ?? undefined, body: JSON.parse(String(options?.body)) });
        if (recoverExchange && exchangeRequests.length === 1) {
          return Response.json({ detail: 'dependency_unavailable' }, { status: 503 });
        }
        for (const socket of ws.clients) socket.send(JSON.stringify({ stream_id: rendererId, assignment_id: 'assignment', assignment_generation: 1, sequence: 1, story_block_id: evdId, script: { sequence: 1, episode_id: 77, command_groups: [{ id: 'group', commands: [{ command: 'Talk', args: { character: 'Alex', dialogue: 'Hello Sam.' } }] }] } }));
        return Response.json({ session: { audience: 'external-audience', story_id: 77, message_channel_id: storyChannel, principal_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', scopes: ['chat.read', 'chat.write'] }, websocket_url: 'ws://127.0.0.1:8080/api/v1/external-audience/ws' }, { headers: { 'set-cookie': 'pickford_audience=opaque; HttpOnly; Path=/api/v1/external-audience' } });
      }
      throw new Error(`unexpected fetch ${target}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const media = playout();
    const manager = new ExternalRendererRunManager(media.manager);
    const run = manager.start({
      ...config(`http://127.0.0.1:${port}`),
      ...(explicitExchange ? { audienceExchangeUrl: exchangeUrl } : {}),
      ...(supersedeExisting ? { supersedeExistingStory: true } : {}),
    });
    expect(run).toMatchObject({ startMode: 'opaque', storyId: null, storyRunId: null, audienceJoinUrl: null });
    try {
      await vi.waitFor(() => expect(run.dssCommandsRendered).toBe(1), { timeout: 3_000 });
      const expectedStart = {
        evd_id: evdId,
        idempotency_key: `video-renderer:${rendererId}:${evdId}:${run.runId}`,
        ...(supersedeExisting ? { supersede_existing: true } : {}),
      };
      expect(startBodies).toEqual(recoverStart ? [expectedStart, expectedStart] : [expectedStart]);
      if (recoverStart || recoverExchange) {
        expect(frames.filter(f => f.type === 'renderer.hello')).toHaveLength(1);
        expect(frames.some(f => f.type === 'renderer.heartbeat')).toBe(true);
        expect(run.failures).toEqual([]);
      }
      expect(run.storyStartStatus).toBe(202);
      expect(run).toMatchObject({ storyRunId, audienceJoinUrl: 'http://audience.example:3000/audience/opaque-handle-1234567890', storyId: 77, storyMessageChannelId: storyChannel });
      const expectedExchange = { url: exchangeUrl, origin: 'http://audience.example:3000', body: { opaque_handle: 'opaque-handle-1234567890' } };
      expect(exchangeRequests).toEqual(recoverExchange ? [expectedExchange, expectedExchange] : [expectedExchange]);
      if (recoverExchange) expect(warning).toHaveBeenCalledWith('Audience exchange HTTP 503; retrying within the story start recovery window.');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('opaque-handle-1234567890');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('test-installation');
      const result = await manager.submitAudienceMessage({ externalSubject: 'viewer:1', displayName: 'Ada', content: 'Turn left', idempotencyKey: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
      expect(result).toEqual({ accepted: true, duplicate: false, messageId: 'kernel-message-1' });
      expect(frames.find(f => f.type === 'audience.message')).toMatchObject({ story_id: 77 });
      expect(generateVideo).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(run)).not.toContain('test-installation');
    } finally {
      warning.mockRestore();
      await manager.stopAll();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
    expect(run.state).toBe('stopped');
  });

  it.each(['stop', 'disconnect'])('cancels pending startup recovery on %s', async action => {
    vi.stubEnv('FAL_KEY', 'test-fal');
    const http = createServer();
    const ws = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    ws.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'renderer.hello') socket.send(JSON.stringify({ type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null, session_id: 'session', session_epoch: 1, lease_seconds: 30 }));
      if (frame.type === 'renderer.asset_manifest') socket.send(JSON.stringify({ type: 'renderer.asset_manifest.accepted', sha256: frame.sha256 }));
    }));
    let starts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/login')) return Response.json({ access_token: 'test-token', websocket_url: `ws://127.0.0.1:${port}` });
      starts++;
      return Response.json({ detail: 'timeout' }, { status: 502 });
    }));
    const manager = new ExternalRendererRunManager(playout().manager);
    const run = manager.start(config(`http://127.0.0.1:${port}`));
    try {
      await vi.waitFor(() => expect(starts).toBe(1));
      expect(run.state).toBe('connecting');
      if (action === 'stop') await manager.stopAll();
      else for (const socket of ws.clients) socket.close();
      await vi.waitFor(() => expect(run.state).toBe(action === 'stop' ? 'stopped' : 'failed'));
      await new Promise(resolve => setTimeout(resolve, 1_100));
      expect(starts).toBe(1);
      expect(generateVideo).not.toHaveBeenCalled();
    } finally {
      await manager.stopAll();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });

  it('gives every run of the same EVD a distinct idempotency key', () => {
    vi.stubEnv('FAL_KEY', 'test-fal');
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    const manager = new ExternalRendererRunManager(playout().manager);
    const first = manager.start(config());
    const second = new ExternalRendererRunManager(playout().manager).start(config());
    expect(first.runId).toMatch(uuidPattern);
    expect(first.runId).not.toBe(second.runId);
  });

  it.each([
    ['a non-committed status', { story_run_id: storyRunId, audience_join_url: 'http://audience.example/audience/opaque-handle-1234567890', status: 'pending' }, 'did not commit audience readiness'],
    ['a join URL without an opaque handle', { story_run_id: storyRunId, audience_join_url: 'http://audience.example/watch?handle=x', status: 'audience_ready' }, 'invalid audience join URL'],
  ])('fails closed when the kernel returns %s', async (_label, payload, failure) => {
    vi.stubEnv('FAL_KEY', 'test-fal');
    const http = createServer();
    const ws = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    ws.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'renderer.hello') socket.send(JSON.stringify({ type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null, session_id: 'session', session_epoch: 1, lease_seconds: 30 }));
      if (frame.type === 'renderer.asset_manifest') socket.send(JSON.stringify({ type: 'renderer.asset_manifest.accepted', sha256: frame.sha256 }));
    }));
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/login')) return Response.json({ access_token: 'test-token', websocket_url: `ws://127.0.0.1:${port}` });
      if (String(url).endsWith('/api/v1/renderers/start-story')) return Response.json(payload, { status: 202 });
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    const media = playout();
    const manager = new ExternalRendererRunManager(media.manager);
    const run = manager.start(config(`http://127.0.0.1:${port}`));
    try {
      await vi.waitFor(() => expect(run.state).toBe('failed'));
      expect(run.failures.join(' ')).toContain(failure);
    } finally {
      await manager.stopAll();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });

  it('adopts the story id and room shortlink the start response now carries', async () => {
    vi.stubEnv('FAL_KEY', 'test-fal');
    const http = createServer();
    const ws = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    ws.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'renderer.hello') socket.send(JSON.stringify({ type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null, session_id: 'session', session_epoch: 1, lease_seconds: 30 }));
      if (frame.type === 'renderer.asset_manifest') socket.send(JSON.stringify({ type: 'renderer.asset_manifest.accepted', sha256: frame.sha256 }));
    }));
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/login')) return Response.json({ access_token: 'test-token', websocket_url: `ws://127.0.0.1:${port}` });
      if (String(url).endsWith('/api/v1/renderers/start-story')) {
        return Response.json({
          story_run_id: storyRunId, story_id: 77, room_shortlink: 'night-shift-1',
          audience_join_url: 'http://audience.example/audience/opaque-handle-1234567890', status: 'audience_ready',
        }, { status: 202 });
      }
      return Response.json({ session: { story_id: 77, message_channel_id: storyChannel }, websocket_url: 'ws://127.0.0.1:8080/ws' });
    }));
    const manager = new ExternalRendererRunManager(playout().manager);
    const run = manager.start(config(`http://127.0.0.1:${port}`));
    try {
      await vi.waitFor(() => expect(run.storyId).toBe(77));
      expect(run.roomShortlink).toBe('night-shift-1');
    } finally {
      await manager.stopAll();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });

  it('fails closed when the audience exchange contradicts the story the start response named', async () => {
    vi.stubEnv('FAL_KEY', 'test-fal');
    const http = createServer();
    const ws = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    ws.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'renderer.hello') socket.send(JSON.stringify({ type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null, session_id: 'session', session_epoch: 1, lease_seconds: 30 }));
      if (frame.type === 'renderer.asset_manifest') socket.send(JSON.stringify({ type: 'renderer.asset_manifest.accepted', sha256: frame.sha256 }));
    }));
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/login')) return Response.json({ access_token: 'test-token', websocket_url: `ws://127.0.0.1:${port}` });
      if (String(url).endsWith('/api/v1/renderers/start-story')) {
        return Response.json({ story_run_id: storyRunId, story_id: 77, audience_join_url: 'http://audience.example/audience/opaque-handle-1234567890', status: 'audience_ready' }, { status: 202 });
      }
      return Response.json({ session: { story_id: 91, message_channel_id: storyChannel }, websocket_url: 'ws://127.0.0.1:8080/ws' });
    }));
    const manager = new ExternalRendererRunManager(playout().manager);
    const run = manager.start(config(`http://127.0.0.1:${port}`));
    try {
      await vi.waitFor(() => expect(run.state).toBe('failed'));
      expect(run.failures.join(' ')).toContain('named a different story than the start response');
    } finally {
      await manager.stopAll();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });

  it('surfaces a STORY_BUNDLE_NOT_READY refusal in the words the backend used', async () => {
    vi.stubEnv('FAL_KEY', 'test-fal');
    const http = createServer();
    const ws = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    ws.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'renderer.hello') socket.send(JSON.stringify({ type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null, session_id: 'session', session_epoch: 1, lease_seconds: 30 }));
      if (frame.type === 'renderer.asset_manifest') socket.send(JSON.stringify({ type: 'renderer.asset_manifest.accepted', sha256: frame.sha256 }));
    }));
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/login')) return Response.json({ access_token: 'test-token', websocket_url: `ws://127.0.0.1:${port}` });
      if (String(url).endsWith('/api/v1/renderers/start-story')) {
        return Response.json({
          detail: { code: 'STORY_BUNDLE_NOT_READY', state: 'preparing', message: 'Images are still generating for this StoryBundle.' },
        }, { status: 409 });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    const manager = new ExternalRendererRunManager(playout().manager);
    const run = manager.start(config(`http://127.0.0.1:${port}`));
    try {
      await vi.waitFor(() => expect(run.state).toBe('failed'));
      expect(run.failures.join(' ')).toContain('Images are still generating for this StoryBundle.');
    } finally {
      await manager.stopAll();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });

  it('rejects an exchange that names a different story than the assignment', async () => {
    vi.stubEnv('FAL_KEY', 'test-fal');
    const http = createServer();
    const ws = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    ws.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'renderer.hello') socket.send(JSON.stringify({ type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null, session_id: 'session', session_epoch: 1, lease_seconds: 30 }));
      if (frame.type === 'renderer.asset_manifest') socket.send(JSON.stringify({ type: 'renderer.asset_manifest.accepted', sha256: frame.sha256 }));
    }));
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/login')) return Response.json({ access_token: 'test-token', websocket_url: `ws://127.0.0.1:${port}` });
      if (String(url).endsWith('/api/v1/renderers/start-story')) return Response.json({ story_run_id: storyRunId, audience_join_url: 'http://audience.example/audience/opaque-handle-1234567890', status: 'audience_ready' }, { status: 202 });
      for (const socket of ws.clients) socket.send(JSON.stringify({ stream_id: rendererId, assignment_id: 'assignment', assignment_generation: 1, sequence: 1, story_block_id: evdId, script: { sequence: 1, episode_id: 78, command_groups: [{ id: 'group', commands: [{ command: 'Talk', args: { character: 'Alex', dialogue: 'Hello Sam.' } }] }] } }));
      return Response.json({ session: { story_id: 77, message_channel_id: storyChannel }, websocket_url: 'ws://127.0.0.1:8080/ws' });
    }));
    const media = playout();
    const manager = new ExternalRendererRunManager(media.manager);
    const run = manager.start(config(`http://127.0.0.1:${port}`));
    try {
      await vi.waitFor(() => expect(run.state).toBe('failed'));
      expect(run.failures.join(' ')).toContain('DSS command targeted another story');
    } finally {
      await manager.stopAll();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });
});
