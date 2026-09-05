import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { ExternalRendererRunManager } from './external-renderer.js';
import { DssShotPlanner } from './shot-planner.js';
import type { PlayoutManager } from './playout.js';
import { generateVideo } from './fal.js';
import { extractVideoFrame } from './video-frame.js';

vi.mock('./fal.js', () => ({ generateVideo: vi.fn() }));
vi.mock('./video-frame.js', () => ({ extractVideoFrame: vi.fn() }));

type Json = Record<string, unknown>;
type Generated = Awaited<ReturnType<typeof generateVideo>>;
const rendererId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const talk = (character = 'Alex'): Json => ({ command: 'talk', args: { character, dialogue: `Hello from ${character}.`, audio_duration: 5, camera_shot: 'Character_Medium' } });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const result = (name: string) => ({ videoUrl: `https://video.example/${name}.mp4` } as Generated);

async function bridge(options: { model?: 'fal-max-ref2v' | 'fal-turbo-i2v'; continuity?: 'none' | 'camera-anchors' | 'last-frame-chain'; concurrency?: number; budget?: number } = {}) {
  vi.stubEnv('FAL_KEY', 'fixture-key');
  vi.mocked(generateVideo).mockReset();
  vi.mocked(extractVideoFrame).mockReset().mockResolvedValue('data:image/jpeg;base64,YW5jaG9y');
  const pending: Array<{ resolve(value: Generated): void; reject(error: Error): void }> = [];
  vi.mocked(generateVideo).mockImplementation((_input, settings) => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    settings.signal?.addEventListener('abort', () => reject(new Error('Fixture generation aborted')), { once: true });
  }));
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const events: Json[] = [];
  const send = (value: Json) => { for (const socket of ws.clients) socket.send(JSON.stringify(value)); };
  ws.on('connection', socket => socket.on('message', raw => {
    const event = JSON.parse(raw.toString()); events.push(event);
    if (event.type === 'renderer.hello') send({ type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null, session_id: 'fixture-session', session_epoch: 1, lease_seconds: 30 });
  }));
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).endsWith('/login')
    ? Response.json({ access_token: 'fixture-token', websocket_url: `ws://127.0.0.1:${port}` })
    : Response.json({ renderer_id: rendererId }, { status: 202 })));
  let playedThroughPosition = -1;
  const enqueue = vi.fn();
  const stop = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({ sessionId: 'fixture-media', hlsUrl: '/hls/fixture.m3u8', enqueue, status: () => ({ state: 'streaming', playedThroughPosition }) }));
  const manager = new ExternalRendererRunManager({ start, stop } as unknown as PlayoutManager);
  const run = manager.start({
    baseUrl: `http://127.0.0.1:${port}`, environment: 'local', rendererId,
    credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', clientSecret: 'fixture-secret', rendererVersion: 'h3.test.v1.0', storyId: 42,
    registerManifest: false, initialImageUrl: 'https://images.example/initial.png', clipDurationSeconds: 5,
    rendererConfig: { model: options.model ?? 'fal-max-ref2v', continuity: options.continuity ?? 'none', concurrency: options.concurrency ?? 2, maxBufferedSeconds: options.budget ?? 30 },
  });
  await vi.waitFor(() => expect(run.state).toBe('running'));
  const frame = (sequence: number, commands: Json[] = [talk()], overrides: Json = {}) => ({
    stream_id: rendererId, assignment_id: 'fixture-assignment', assignment_generation: 1, sequence,
    story_block_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', script: { sequence, command_groups: [{ id: `group-${sequence}`, commands }] }, ...overrides,
  });
  return {
    run, pending, enqueue, start, stop, send, frame, manager,
    completed: () => events.filter(event => event.event === 'completed').map(event => event.dss_id),
    play: (position: number) => { playedThroughPosition = position; },
    disconnect: () => { for (const socket of ws.clients) socket.close(); },
    close: async () => { await manager.stopAll(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())); },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('rolling DSS generation and ordered playout', () => {
  it('generates later received payloads and prefeeds clips while the first is playing, without early ACKs', async () => {
    const fixture = await bridge();
    const compile = vi.spyOn(DssShotPlanner.prototype, 'planGroup');
    try {
      fixture.send(fixture.frame(1));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(1));
      fixture.pending[0].resolve(result('a'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(1));
      fixture.send(fixture.frame(2));
      fixture.send(fixture.frame(1));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(2));
      fixture.pending[1].resolve(result('b'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(2));
      expect(compile).toHaveBeenCalledTimes(2);
      expect(fixture.run.dssSequences).toEqual([1, 2]);
      expect(fixture.completed()).toEqual([]);
      fixture.play(0);
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-1']));
      fixture.play(1);
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-1', 'group-2']));
    } finally { await fixture.close(); }
  });

  it('keeps global duration/concurrency bounds and FIFO playout when future generation finishes first', async () => {
    const fixture = await bridge({ concurrency: 2, budget: 10 });
    try {
      for (let seq = 1; seq <= 4; seq++) fixture.send(fixture.frame(seq));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(2));
      fixture.pending[1].resolve(result('b'));
      await sleep(30);
      expect(fixture.enqueue).not.toHaveBeenCalled();
      expect(fixture.pending).toHaveLength(2);
      fixture.pending[0].resolve(result('a'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(2));
      expect(fixture.pending).toHaveLength(2);
      expect(fixture.enqueue.mock.calls.map(([clip]) => clip.videoUrl)).toEqual([result('a').videoUrl, result('b').videoUrl]);
      fixture.play(0);
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(3));
      fixture.pending[2].resolve(result('c'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-1']));
      expect(fixture.pending).toHaveLength(3);
      fixture.play(1);
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(4));
      fixture.pending[3].resolve(result('d'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(4));
      fixture.play(3);
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-1', 'group-2', 'group-3', 'group-4']));
      expect(fixture.enqueue.mock.calls.map(([clip]) => clip.position)).toEqual([0, 1, 2, 3]);
    } finally { await fixture.close(); }
  });

  it.each(['camera-anchors', 'last-frame-chain'] as const)('keeps %s dependencies across payload boundaries', async continuity => {
    const fixture = await bridge({ model: continuity === 'camera-anchors' ? 'fal-max-ref2v' : 'fal-turbo-i2v', continuity });
    try {
      fixture.send(fixture.frame(1)); fixture.send(fixture.frame(2));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(1));
      fixture.pending[0].resolve(result('a'));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(2));
      const second = vi.mocked(generateVideo).mock.calls[1][0];
      if (continuity === 'camera-anchors') expect(second.referenceImageUrls?.at(-1)).toBe('data:image/jpeg;base64,YW5jaG9y');
      else expect(second.initialImageUrl).toBe('data:image/jpeg;base64,YW5jaG9y');
      expect(extractVideoFrame).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ position: continuity === 'camera-anchors' ? 'first' : 'last' }));
      fixture.pending[1].resolve(result('b'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(2));
      expect(fixture.completed()).toEqual([]);
    } finally { await fixture.close(); }
  });

  it.each([false, true])('preserves a timed group barrier (control-only=%s) while generating future video', async controlOnly => {
    const fixture = await bridge();
    try {
      fixture.send(fixture.frame(1, [...(controlOnly ? [] : [talk()]), { command: 'delay', args: { seconds: 0.2 } }]));
      fixture.send(fixture.frame(2));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(controlOnly ? 1 : 2));
      fixture.pending.forEach((pending, index) => pending.resolve(result(String(index))));
      await sleep(50);
      expect(fixture.enqueue).toHaveBeenCalledTimes(controlOnly ? 0 : 1);
      expect(fixture.completed()).toEqual([]);
      if (!controlOnly) fixture.play(0);
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(controlOnly ? 1 : 2));
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-1']));
    } finally { await fixture.close(); }
  });

  it('allows a payload larger than the duration budget to progress before its whole group has been enqueued', async () => {
    const fixture = await bridge({ budget: 5 });
    try {
      fixture.send(fixture.frame(1, [talk('Alex'), talk('Sam'), talk('Alex')]));
      for (let index = 0; index < 3; index++) {
        await vi.waitFor(() => expect(fixture.pending).toHaveLength(index + 1));
        fixture.pending[index].resolve(result(String(index)));
        await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(index + 1));
        expect(fixture.completed()).toEqual([]);
        fixture.play(index);
      }
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-1']));
    } finally { await fixture.close(); }
  });

  it('starts one delivered clip and lets its real completion unlock an ACK-gated next payload', async () => {
    const fixture = await bridge();
    try {
      expect(fixture.start).toHaveBeenCalledWith({ startupBufferClips: 1 });
      fixture.send(fixture.frame(0, [{ command: 'delay', args: { seconds: 60 } }]));
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-0']));
      expect(fixture.pending).toHaveLength(0);
      fixture.send(fixture.frame(1));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(1));
      fixture.pending[0].resolve(result('a'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(1));
      expect(fixture.completed()).toEqual(['group-0']);
      fixture.play(0);
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-0', 'group-1']));
      fixture.send(fixture.frame(2));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(2));
      fixture.pending[1].resolve(result('b'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(2));
    } finally { await fixture.close(); }
  });

  it('starts the next-DSS idle timeout only after outstanding generation and playback finish', async () => {
    const fixture = await bridge();
    const originalTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) =>
      originalTimeout(callback, milliseconds === 300_000 ? 500 : milliseconds, ...args)) as typeof setTimeout);
    // Keep the separate socket-liveness timer healthy throughout this test.
    const heartbeat = setInterval(() => fixture.send({ type: 'renderer.heartbeat.accepted' }), 20);
    try {
      fixture.send(fixture.frame(1));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(1));
      await sleep(650);
      expect(fixture.run.state).toBe('running');
      fixture.pending[0].resolve(result('a'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(1));
      await sleep(650);
      expect(fixture.run.state).toBe('running');
      fixture.play(0);
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-1']));
      await vi.waitFor(() => expect(fixture.run.state).toBe('failed'));
      expect(fixture.run.failures.join(' ')).toContain('after playback became idle');
    } finally { clearInterval(heartbeat); await fixture.close(); }
  });

  it.each(['stop', 'replacement', 'close', 'future-failure'] as const)('fences pending work and ACKs promptly on %s while the first clip plays', async action => {
    const fixture = await bridge({ concurrency: 1 });
    try {
      fixture.send(fixture.frame(1));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(1));
      fixture.pending[0].resolve(result('a'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(1));
      fixture.send(fixture.frame(2)); fixture.send(fixture.frame(3));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(2));
      if (action === 'stop') await fixture.manager.stopAll();
      else if (action === 'replacement') fixture.send(fixture.frame(4, [], { assignment_id: 'replacement', assignment_generation: 2 }));
      else if (action === 'close') fixture.disconnect();
      else fixture.pending[1].reject(new Error('Future clip failed'));
      await vi.waitFor(() => expect(fixture.run.state).toBe(action === 'stop' ? 'stopped' : 'failed'));
      fixture.play(0);
      await fixture.manager.stopAll();
      await sleep(30);
      expect(fixture.pending).toHaveLength(2);
      expect(fixture.enqueue).toHaveBeenCalledTimes(1);
      expect(fixture.completed()).toEqual([]);
      expect(fixture.stop).toHaveBeenCalledOnce();
      if (action === 'future-failure') expect(fixture.run.failures.join(' ')).toContain('Future clip failed');
    } finally { await fixture.close(); }
  });

  it('caps prepared control payloads and fails closed when received DSS overruns the pending buffer', async () => {
    const fixture = await bridge();
    const compile = vi.spyOn(DssShotPlanner.prototype, 'planGroup');
    try {
      fixture.send(fixture.frame(1, [{ command: 'delay', args: { seconds: 60 } }]));
      for (let seq = 2; seq <= 40; seq++) fixture.send(fixture.frame(seq, [{ command: 'set fps', args: {} }]));
      await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(32));
      await sleep(30);
      expect(compile).toHaveBeenCalledTimes(32);
      expect(fixture.pending).toHaveLength(0);
      for (let seq = 41; seq <= 400; seq++) fixture.send(fixture.frame(seq, [{ command: 'set fps', args: {} }]));
      await vi.waitFor(() => expect(fixture.run.state).toBe('failed'));
      expect(fixture.run.failures.join(' ')).toContain('receive buffer exceeded');
      expect(fixture.completed()).toEqual([]);
      expect(compile).toHaveBeenCalledTimes(32);
    } finally { await fixture.close(); }
  });
});
