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

async function bridge(options: { model?: 'fal-max-ref2v' | 'fal-turbo-i2v'; continuity?: 'none' | 'camera-anchors' | 'last-frame-chain'; concurrency?: number; budget?: number; shotPlanner?: Json; verdicts?: boolean } = {}) {
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
    if (options.verdicts && event.type === 'renderer.event') send({ type: 'renderer.event.verdict', protocol_version: 1, verdict: {
      verdict_id: event.client_event_id, client_event_id: event.client_event_id, event_message_id: event.client_event_id,
      route: { tier: 'renderer-dev', environment: 'local', project_id: '11111111-1111-4111-8111-111111111111', story_run_id: '22222222-2222-4222-8222-222222222222', renderer_id: rendererId, stream_id: rendererId, renderer_lease_id: event.assignment_id, assignment_generation: event.assignment_generation },
      correlation: { episode_id: 42, sequence: event.sequence, supplied_episode_id: 42, supplied_sequence: event.sequence },
      outcome: 'accepted', retryable: false, confirmed_frontier: event.sequence, missing_sequence_ranges: [], occurred_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
    } });
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
    shotPlanner: options.shotPlanner,
  });
  await vi.waitFor(() => expect(run.state).toBe('running'));
  const frame = (sequence: number, commands: Json[] = [talk()], overrides: Json = {}) => ({
    stream_id: rendererId, assignment_id: 'fixture-assignment', assignment_generation: 1, sequence,
    story_block_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', script: { sequence, command_groups: [{ id: `group-${sequence}`, commands }] }, ...overrides,
  });
  // Matches the deployed protobuf-to-dict shape: metadata lives on the script,
  // one command group normally, while the wire also permits multiple groups.
  const chunk = (sequence: number, sceneIndex: number, commands: Json[][]) => frame(sequence, [], {
    story_block_id: undefined,
    script: {
      id: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, episode_id: 42, scene_index: sceneIndex,
      story_block_index: sequence, story_block_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', sequence,
      command_groups: commands.map((group, index) => ({ id: `group-${sequence}-${index}`, commands: group })),
    },
  });
  return {
    run, pending, enqueue, start, stop, send, frame, chunk, manager,
    completed: () => events.filter(event => event.event === 'completed').map(event => event.dss_id),
    play: (position: number) => { playedThroughPosition = position; },
    disconnect: () => { for (const socket of ws.clients) socket.close(); },
    close: async () => { await manager.stopAll(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())); },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('rolling DSS generation and ordered playout', () => {
  it('compiles streamed setup and camera A/B/A chunks with configured references before dialogue playback ACKs', async () => {
    const fixture = await bridge({ continuity: 'camera-anchors', verdicts: true, shotPlanner: {
      characters: { Alex: { imageUrl: 'https://images.example/alex.png' }, Sam: { imageUrl: 'https://images.example/sam.png' } },
      sets: { lobby: { imageUrl: 'https://images.example/lobby.png' } },
      markNames: { left_mark: 'at the left window', right_mark: 'beside the right doorway' },
    } });
    vi.mocked(extractVideoFrame).mockImplementation(async url => `data:image/jpeg;base64,${Buffer.from(url).toString('base64')}`);
    const camera = (character: string): Json => ({ command: 'character camera', args: { character, shot: 'Character_CloseUp' } });
    const dialogue = (character: string): Json => ({ command: 'talk', args: { character, dialogue: `${character} follows the conversation.`, audio_duration: 5 } });
    try {
      fixture.send(fixture.chunk(1, 0, [[
        { command: 'enable set', args: { set: 'lobby' } },
        { command: 'add character', args: { character: 'Alex', point: { mark: 'left_mark' } } },
        { command: 'add character', args: { character: 'Sam', point: { mark: 'right_mark' } } }, camera('Alex'),
      ]]));
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-1-0']));
      expect(fixture.pending).toHaveLength(0);
      fixture.send(fixture.chunk(2, 0, [[dialogue('Alex')]]));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(1));
      const first = vi.mocked(generateVideo).mock.calls[0][0];
      expect(first.prompt).toContain('close-up of Alex');
      expect(first.prompt).toContain('at the left window');
      expect(first.referenceImageUrls).toContain('https://images.example/alex.png');
      expect(first.referenceImageUrls).toContain('https://images.example/lobby.png');
      expect(first.referenceImageUrls).not.toContain('https://images.example/sam.png');

      fixture.send(fixture.chunk(3, 0, [[camera('Sam')], [dialogue('Sam')]]));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(2));
      expect(vi.mocked(generateVideo).mock.calls[1][0].prompt).toContain('close-up of Sam');
      expect(vi.mocked(generateVideo).mock.calls[1][0].referenceImageUrls).toContain('https://images.example/sam.png');
      fixture.pending[1].resolve(result('angle-b'));
      await vi.waitFor(() => expect(extractVideoFrame).toHaveBeenCalledTimes(1));
      expect(fixture.enqueue).not.toHaveBeenCalled();
      fixture.send(fixture.chunk(4, 0, [[camera('Alex'), dialogue('Alex')]]));
      await sleep(30);
      expect(fixture.pending).toHaveLength(2);
      fixture.pending[0].resolve(result('angle-a'));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(3));
      const third = vi.mocked(generateVideo).mock.calls[2][0];
      expect(third.referenceImageUrls?.at(-1)).toBe(`data:image/jpeg;base64,${Buffer.from(result('angle-a').videoUrl).toString('base64')}`);
      expect(third.prompt).toContain('close-up of Alex');
      fixture.pending[2].resolve(result('return-a'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(3));
      expect(fixture.enqueue.mock.calls.map(([clip]) => clip.videoUrl)).toEqual([result('angle-a').videoUrl, result('angle-b').videoUrl, result('return-a').videoUrl]);
      expect(fixture.completed()).toEqual(['group-1-0']);
      fixture.play(0);
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-1-0', 'group-2-0', 'group-3-0']));
      fixture.play(1);
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-1-0', 'group-2-0', 'group-3-0', 'group-3-1']));
      fixture.play(2);
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-1-0', 'group-2-0', 'group-3-0', 'group-3-1', 'group-4-0']));
      await vi.waitFor(() => expect(fixture.run.eventVerdicts).toMatchObject({ pending: 0, acknowledged: 8, refused: 0 }));
    } finally { await fixture.close(); }
  });

  it('records per-clip timings and classifies camera anchors as established or reused', async () => {
    const fixture = await bridge({ continuity: 'camera-anchors', shotPlanner: {
      characters: { Alex: { imageUrl: 'https://images.example/alex.png' }, Sam: { imageUrl: 'https://images.example/sam.png' } },
      sets: { lobby: { imageUrl: 'https://images.example/lobby.png' } },
    } });
    const camera = (character: string): Json => ({ command: 'character camera', args: { character, shot: 'Character_CloseUp' } });
    const dialogue = (character: string): Json => ({ command: 'talk', args: { character, dialogue: `${character} speaks.`, audio_duration: 5 } });
    const generated = (name: string) => ({ ...result(name), requestId: `fal-${name}` } as Generated);
    try {
      fixture.send(fixture.chunk(1, 0, [[
        { command: 'enable set', args: { set: 'lobby' } },
        { command: 'add character', args: { character: 'Alex', point: { mark: 'left_mark' } } },
        { command: 'add character', args: { character: 'Sam', point: { mark: 'right_mark' } } },
        camera('Alex'),
      ]]));
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-1-0']));
      expect(fixture.run.clips).toHaveLength(0);

      fixture.send(fixture.chunk(2, 0, [[dialogue('Alex')]]));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(1));
      fixture.send(fixture.chunk(3, 0, [[camera('Sam')], [dialogue('Sam')]]));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(2));
      fixture.send(fixture.chunk(4, 0, [[camera('Alex'), dialogue('Alex')]]));
      await vi.waitFor(() => expect(fixture.run.clips).toHaveLength(3));

      const [alexA, samB, alexReuse] = fixture.run.clips;
      expect(fixture.run.clips.map(clip => clip.anchor)).toEqual(['establish', 'establish', 'reuse']);
      expect(fixture.run.clips.map(clip => [clip.sequence, clip.position])).toEqual([[2, 0], [3, 1], [4, 2]]);
      expect(fixture.run.clips.map(clip => clip.continuity)).toEqual(['camera-anchors', 'camera-anchors', 'camera-anchors']);
      expect(alexReuse.anchorKey).toBe(alexA.anchorKey);
      expect(samB.anchorKey).not.toBe(alexA.anchorKey);
      expect(alexA.groupId).toBe('group-2-0');
      expect(alexA.durationSeconds).toBe(5);
      expect(fixture.run).toMatchObject({ anchorsEstablished: 2, anchorsReused: 1 });
      // The reusing shot is still blocked on its anchor, so it is planned but unsubmitted.
      expect(alexReuse.submittedAt).toBeNull();
      expect(alexA.submittedAt).not.toBeNull();
      expect(alexA.readyAt).toBeNull();
      expect(fixture.run.generationMsPercentiles).toBeNull();

      await sleep(5);
      fixture.pending[0].resolve(generated('angle-a'));
      fixture.pending[1].resolve(generated('angle-b'));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(3));
      fixture.pending[2].resolve(generated('return-a'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(3));

      for (const clip of fixture.run.clips) {
        expect(clip.readyAt).not.toBeNull();
        expect(Date.parse(clip.readyAt!)).toBeGreaterThanOrEqual(Date.parse(clip.submittedAt!));
        expect(clip.generationMs).toBeGreaterThanOrEqual(0);
        expect(clip.playedAt).toBeNull();
      }
      expect(fixture.run.clips.map(clip => clip.providerRequestId)).toEqual(['fal-angle-a', 'fal-angle-b', 'fal-return-a']);
      expect(alexA.generationMs).toBeGreaterThan(0);
      const percentiles = fixture.run.generationMsPercentiles!;
      expect(percentiles.min).toBeLessThanOrEqual(percentiles.median);
      expect(percentiles.median).toBeLessThanOrEqual(percentiles.max);
      expect(percentiles.max).toBe(Math.max(...fixture.run.clips.map(clip => clip.generationMs!)));

      fixture.play(0);
      await vi.waitFor(() => expect(fixture.run.clips[0].playedAt).not.toBeNull());
      expect(fixture.run.clips[2].playedAt).toBeNull();
      fixture.play(2);
      await vi.waitFor(() => expect(fixture.run.clips[2].playedAt).not.toBeNull());
      expect(fixture.run.clipsRendered).toBe(3);
    } finally { await fixture.close(); }
  });

  it.each(['camera-anchors', 'last-frame-chain'] as const)('resets %s on a new scene_index without waiting for a whole scene or certified context', async continuity => {
    const fixture = await bridge({ model: continuity === 'camera-anchors' ? 'fal-max-ref2v' : 'fal-turbo-i2v', continuity });
    try {
      fixture.send(fixture.chunk(1, 0, [[
        { command: 'enable set', args: { set: 'lobby' } },
        { command: 'add character', args: { character: 'Sam', point: { mark: 'old_doorway' } } },
        talk('Alex'),
      ]]));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(1));
      fixture.pending[0].resolve(result('old-scene'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(1));
      fixture.send(fixture.chunk(2, 0, [[talk('Alex')]]));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(2));
      const sameScene = vi.mocked(generateVideo).mock.calls[1][0];
      if (continuity === 'camera-anchors') expect(sameScene.referenceImageUrls?.at(-1)).toMatch(/^data:image/);
      else expect(sameScene.initialImageUrl).toMatch(/^data:image/);
      fixture.pending[1].resolve(result('old-scene-again'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(2));
      fixture.send(fixture.chunk(3, 1, [[{ command: 'enable set', args: { set: 'lobby' } }, talk('Alex')]]));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(3));
      const newScene = vi.mocked(generateVideo).mock.calls[2][0];
      expect(newScene.prompt).not.toContain('old doorway');
      expect(newScene.prompt).not.toContain('Sam');
      if (continuity === 'camera-anchors') expect(newScene.referenceImageUrls).toEqual(['https://images.example/initial.png']);
      else expect(newScene.initialImageUrl).toBe('https://images.example/initial.png');
      expect(fixture.completed()).toEqual([]);
    } finally { await fixture.close(); }
  });

  it('renders sequence-zero dialogue and honors its timing instead of acknowledging it as initialization', async () => {
    const fixture = await bridge();
    try {
      fixture.send(fixture.chunk(0, 0, [[talk(), { command: 'delay', args: { seconds: 0.1 } }]]));
      await vi.waitFor(() => expect(fixture.pending).toHaveLength(1));
      fixture.pending[0].resolve(result('sequence-zero'));
      await vi.waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(1));
      expect(fixture.completed()).toEqual([]);
      fixture.play(0);
      await vi.waitFor(() => expect(fixture.completed()).toEqual(['group-0-0']));
      expect(fixture.run.dssCommandsRendered).toBe(2);
    } finally { await fixture.close(); }
  });

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
      fixture.send(fixture.frame(0, [{ command: 'set story mode', args: {} }]));
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
