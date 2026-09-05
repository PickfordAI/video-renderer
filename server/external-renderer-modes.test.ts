import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { ExternalRendererRunManager, parseExternalRendererRunConfig } from './external-renderer.js';
import type { PlayoutManager } from './playout.js';
import { generateVideo } from './fal.js';
import { extractVideoFrame } from './video-frame.js';
vi.mock('./fal.js', () => ({ generateVideo: vi.fn() }));
vi.mock('./minimax.js', () => ({ generateMiniMaxVideo: vi.fn(() => { throw new Error('Explicit mode must not use MiniMax directly'); }) }));
vi.mock('./video-frame.js', () => ({ extractVideoFrame: vi.fn(async (url: string) => `data:image/jpeg;base64,${url.endsWith('1.mp4') ? 'YW5jaG9y' : 'bmV4dA=='}`) }));
const rendererId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const blockId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const config = (baseUrl: string) => ({ baseUrl, rendererId, credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', clientSecret: 'mock-secret', rendererVersion: 'h3.test.v1.0', environment: 'local', storyId: 42, roomId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', registerManifest: false, initialImageUrl: 'https://images.example/initial.png' });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('explicit bridge generation modes', () => {
  it('validates budget limits and image requirements before starting a run', () => {
    const base = config('http://127.0.0.1:8193');
    expect(() => parseExternalRendererRunConfig({ ...base, renderMode: 'fal-turbo-i2v', initialImageUrl: undefined })).toThrow('initialImageUrl');
    expect(() => parseExternalRendererRunConfig({ ...base, generationConcurrency: 9 })).toThrow('1 to 8');
    expect(() => parseExternalRendererRunConfig({ ...base, maxBufferedSeconds: 121 })).toThrow('5 to 120');
    const parsed = parseExternalRendererRunConfig({ ...base, renderMode: 'fal-turbo-i2v', rendererConfig: { model: 'fal-max-ref2v', continuity: 'none', concurrency: 3, maxBufferedSeconds: 40 } });
    expect(parsed).toMatchObject({ renderMode: 'fal-max-ref2v', continuityStrategy: 'none', generationConcurrency: 3, maxBufferedSeconds: 40 });
    expect(parsed.rendererConfig).toEqual({ model: 'fal-max-ref2v', continuity: 'none', concurrency: 3, maxBufferedSeconds: 40 });
    expect(() => parseExternalRendererRunConfig({ ...base, rendererConfig: { model: 'fal-turbo-i2v', continuity: 'camera-anchors', concurrency: 2, maxBufferedSeconds: 30 } })).toThrow();
    expect(generateVideo).not.toHaveBeenCalled();
    vi.stubEnv('MINIMAX_API_KEY', 'mock-direct-key'); vi.stubEnv('FAL_KEY', ''); vi.stubEnv('FAL_API_KEY', '');
    const manager = new ExternalRendererRunManager({} as PlayoutManager);
    expect(() => manager.start({ ...base, renderMode: 'fal-max-ref2v' })).toThrow('requires FAL_KEY');
  });

  it.each([['fal-turbo-i2v', false, false, false, undefined], ['fal-max-ref2v', false, false, false, undefined], ['fal-max-ref2v', true, false, false, undefined], ['fal-max-ref2v', false, true, false, undefined], ['fal-max-ref2v', false, false, false, 'none'], ['fal-max-ref2v', false, true, false, 'none'], ['fal-turbo-i2v', false, false, true, undefined]] as const)('generates %s (movement=%s) dependents before playback but completes in story order', async (renderMode, hasMovement, overReferenceBudget, staleAssignment, continuity) => {
    vi.stubEnv('FAL_KEY', 'mock-fal'); vi.stubEnv('MINIMAX_API_KEY', 'mock-direct');
    let generatedCount = 0;
    if (staleAssignment) vi.mocked(extractVideoFrame).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('Frame extraction aborted')), { once: true });
    }));
    vi.mocked(generateVideo).mockImplementation(async () => ({ videoUrl: `https://video.example/${++generatedCount}.mp4` } as Awaited<ReturnType<typeof generateVideo>>));
    const http = createServer(); const ws = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    const events: Record<string, unknown>[] = [];
    ws.on('connection', socket => socket.on('message', raw => {
      const event = JSON.parse(raw.toString()); events.push(event);
      if (event.type === 'renderer.hello') socket.send(JSON.stringify({ type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null, session_id: 'session', session_epoch: 1, lease_seconds: 30 }));
    }));
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/login')) return Response.json({ access_token: 'mock-token', websocket_url: `ws://127.0.0.1:${port}` });
      for (const socket of ws.clients) socket.send(JSON.stringify({ stream_id: rendererId, assignment_id: 'assignment', assignment_generation: 1, sequence: 1, story_block_id: blockId, script: { sequence: 1, command_groups: [
        { id: 'group-1', commands: [...(overReferenceBudget ? Array.from({ length: 11 }, (_, index) => ({ command: 'add character', args: { character: `extra${index}` } })) : []), ...(hasMovement ? [{ command: 'sit', args: { character: 'Alex' } }] : []), { command: 'talk', args: { character: 'Alex', dialogue: 'Hello Sam.', camera_shot: 'Character_Medium' } }] },
        { id: 'group-2', commands: [{ command: 'talk', args: { character: 'Alex', dialogue: 'How are you?', camera_shot: 'Character_Medium' } }] },
      ] } }));
      return Response.json({ renderer_id: rendererId }, { status: 202 });
    }));
    let playedThroughPosition = -1;
    const enqueue = vi.fn(); const stop = vi.fn(async () => undefined);
    const media = { start: vi.fn(async () => ({ sessionId: 'media', hlsUrl: 'https://media.example/index.m3u8', enqueue, status: () => ({ state: 'streaming', playedThroughPosition }) })), stop } as unknown as PlayoutManager;
    const manager = new ExternalRendererRunManager(media);
    const run = manager.start({ ...config(`http://127.0.0.1:${port}`), renderMode, rendererConfig: continuity ? { model: renderMode, continuity, concurrency: 2, maxBufferedSeconds: 30 } : undefined, shotPlanner: overReferenceBudget ? { characters: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`extra${index}`, { imageUrl: `https://images.example/${index}.png` }])) } : {} });
    try {
      if (staleAssignment) {
        await vi.waitFor(() => expect(extractVideoFrame).toHaveBeenCalledTimes(1));
        for (const socket of ws.clients) socket.send(JSON.stringify({ stream_id: rendererId, assignment_id: 'replacement', assignment_generation: 2, sequence: 2, story_block_id: blockId, script: { sequence: 2, command_groups: [] } }));
        await vi.waitFor(() => expect(run.state).toBe('failed'));
        expect(run.failures.join(' ')).toContain('assignment changed');
        expect(generateVideo).toHaveBeenCalledTimes(1);
        expect(enqueue).not.toHaveBeenCalled();
        expect(events.filter(event => event.event === 'completed')).toHaveLength(0);
        return;
      }
      if (overReferenceBudget && continuity !== 'none') {
        await vi.waitFor(() => expect(run.state).toBe('failed'));
        expect(run.failures.join(' ')).toContain('reserving one slot');
        expect(generateVideo).not.toHaveBeenCalled();
        expect(extractVideoFrame).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
        return;
      }
      await vi.waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
      expect(events.filter(event => event.event === 'completed')).toHaveLength(0);
      const calls = vi.mocked(generateVideo).mock.calls;
      expect(calls[0][1].apiKey).toBe('mock-fal');
      if (renderMode === 'fal-turbo-i2v') {
        expect(calls[0][0].initialImageUrl).toBe('https://images.example/initial.png');
        expect(calls[1][0].initialImageUrl).toMatch(/^data:image\/jpeg/);
        expect(extractVideoFrame).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ position: 'last' }));
      } else if (continuity === 'none') {
        expect(calls[0][0].renderMode).toBe('fal-max-ref2v');
        expect(calls[1][0].renderMode).toBe('fal-max-ref2v');
        expect(calls[1][0].referenceImageUrls).toEqual(calls[0][0].referenceImageUrls);
        expect(extractVideoFrame).not.toHaveBeenCalled();
      } else {
        expect(calls[0][0].referenceImageUrls).toContain('https://images.example/initial.png');
        expect(calls[1][0].referenceImageUrls?.at(-1)).toMatch(/^data:image\/jpeg/);
        expect(extractVideoFrame).toHaveBeenCalledTimes(1);
        expect(extractVideoFrame).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ position: hasMovement ? 'last' : 'first' }));
      }
      playedThroughPosition = 0;
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
      expect(enqueue.mock.calls.map(([clip]) => clip.position)).toEqual([0, 1]);
      await vi.waitFor(() => expect(events.filter(event => event.event === 'completed').map(event => event.dss_id)).toEqual(['group-1']));
      playedThroughPosition = 1;
      await vi.waitFor(() => expect(run.dssCommandsRendered).toBe(2 + (hasMovement ? 1 : 0) + (overReferenceBudget ? 11 : 0)));
      await vi.waitFor(() => expect(events.filter(event => event.event === 'completed').map(event => event.dss_id)).toEqual(['group-1', 'group-2']));
    } finally {
      await manager.stopAll();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
    expect(run.state).toBe('stopped');
  });
});
