import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import { ExternalRendererRunManager } from './external-renderer.js';
import { generateVideo } from './fal.js';
import type { PlayoutManager } from './playout.js';
import { generateStillFrame } from './still-frame.js';

vi.mock('./fal.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./fal.js')>()),
  generateVideo: vi.fn(() => { throw new Error('Single Frame must never submit a video job'); }),
}));
vi.mock('./still-frame.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./still-frame.js')>()),
  generateStillFrame: vi.fn(),
}));

const synthesize = vi.fn(async ({ shotId, holdSeconds }: { shotId: string; holdSeconds: number; dialogueAudioUrl: string | null }) => ({
  url: `http://127.0.0.1:4173/still-clips/fixture-token/${shotId.replace(/[^A-Za-z0-9_-]/g, '_')}.mp4`,
  filePath: `/tmp/fixture/${shotId}.mp4`,
  durationSeconds: holdSeconds,
}));
const closeSession = vi.fn(async () => undefined);
vi.mock('./still-clip.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./still-clip.js')>()),
  sharedStillClipStore: () => ({ open: () => ({ synthesize, close: closeSession }) }),
}));

const rendererId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const blockId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('single-frame bridge runs', () => {
  it('renders one still and one held clip per line, on the fal path and in story order', async () => {
    vi.stubEnv('FAL_KEY', 'mock-fal');
    vi.stubEnv('MINIMAX_API_KEY', 'mock-direct');
    let frames = 0;
    vi.mocked(generateStillFrame).mockImplementation(async () => {
      const index = ++frames;
      return {
        imageUrl: `https://v3.fal.media/frame-${index}.jpg`, width: 1280, height: 720,
        requestId: `still-${index}`, modelId: 'fal-ai/flux-2/klein/4b/edit',
        timings: { submitSeconds: 0.2, queueSeconds: 2.1, totalSeconds: 2.4, polls: 3, maxQueuePosition: 0 },
      };
    });

    const http = createServer(); const ws = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    const events: Record<string, unknown>[] = [];
    ws.on('connection', socket => socket.on('message', raw => {
      const event = JSON.parse(raw.toString()); events.push(event);
      if (event.type === 'renderer.hello') socket.send(JSON.stringify({ type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null, session_id: 'session', session_epoch: 1, lease_seconds: 30 }));
    }));
    // Deliver the payload exactly once: a re-broadcast would make the shot count racy.
    let delivered = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/login')) return Response.json({ access_token: 'mock-token', websocket_url: `ws://127.0.0.1:${port}` });
      if (delivered) return Response.json({ renderer_id: rendererId }, { status: 202 });
      delivered = true;
      for (const socket of ws.clients) socket.send(JSON.stringify({
        stream_id: rendererId, assignment_id: 'assignment', assignment_generation: 1, sequence: 1, story_block_id: blockId,
        script: { sequence: 1, command_groups: [
          { id: 'group-1', commands: [{ command: 'talk', args: { character: 'Alex', dialogue: 'Hello Sam.', camera_shot: 'Character_Medium', audio_duration: 4, audio: 'https://audio.example/one.mp3' } }] },
          { id: 'group-2', commands: [{ command: 'talk', args: { character: 'Alex', dialogue: 'How are you?', camera_shot: 'Character_Medium', audio_duration: 22, audio: 'https://audio.example/two.mp3' } }] },
        ] },
      }));
      return Response.json({ renderer_id: rendererId }, { status: 202 });
    }));

    // The per-shot timing line is the evidence basis for the cost/latency comparison, so it is
    // part of the contract, not incidental output.
    const logged: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(message => { logged.push(String(message)); });
    let playedThroughPosition = -1;
    const enqueue = vi.fn();
    const media = {
      start: vi.fn(async () => ({ sessionId: 'media', hlsUrl: 'https://media.example/index.m3u8', enqueue, status: () => ({ state: 'streaming', playedThroughPosition }) })),
      stop: vi.fn(async () => undefined),
    } as unknown as PlayoutManager;
    const manager = new ExternalRendererRunManager(media);
    const run = manager.start({
      baseUrl: `http://127.0.0.1:${port}`, rendererId, credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      clientSecret: 'mock-secret', rendererVersion: 'h3.test.v1.0', environment: 'local', storyId: 42,
      roomId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', registerManifest: false,
      rendererConfig: { model: 'single-frame' },
      shotPlanner: { characters: { Alex: { imageUrl: 'https://images.example/alex.png' } } },
    });

    try {
      await vi.waitFor(() => expect(generateStillFrame).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
      // The mode must never reach a video endpoint; that is the entire cost argument.
      expect(generateVideo).not.toHaveBeenCalled();

      // One still and one synthesized clip per line, handed to playout as a loopback URL.
      expect(synthesize).toHaveBeenCalledTimes(2);
      expect(enqueue.mock.calls.map(([clip]) => clip.videoUrl)).toEqual([
        `http://127.0.0.1:4173/still-clips/fixture-token/${blockId}_group-1_0.mp4`,
        `http://127.0.0.1:4173/still-clips/fixture-token/${blockId}_group-2_0.mp4`,
      ]);
      expect(enqueue.mock.calls.map(([clip]) => clip.position)).toEqual([0, 1]);

      // The 22 s line is one held frame, not two provider-sized fragments, and it carries the
      // kernel's own audio for that line.
      expect(enqueue.mock.calls.map(([clip]) => clip.durationSeconds)).toEqual([5, 22]);
      expect(synthesize.mock.calls.map(([request]) => request.dialogueAudioUrl)).toEqual([
        'https://audio.example/one.mp3', 'https://audio.example/two.mp3',
      ]);
      expect(synthesize.mock.calls.map(([request]) => request.holdSeconds)).toEqual([5, 22]);

      // Progress and completion identities and ordering match the fal path exactly.
      playedThroughPosition = 0;
      await vi.waitFor(() => expect(events.filter(event => event.event === 'completed').map(event => event.dss_id)).toEqual(['group-1']));
      playedThroughPosition = 1;
      await vi.waitFor(() => expect(events.filter(event => event.event === 'completed').map(event => event.dss_id)).toEqual(['group-1', 'group-2']));
      expect(events.filter(event => event.event === 'command_progress')).toHaveLength(2);

      // Stills are a different provider and a different price; the kernel's timeline should say so.
      const finished = events.filter(event => event.event === 'completed');
      for (const event of finished) {
        expect((event.render_metrics as Record<string, unknown>).provider).toBe('fal-image');
      }
      const timings = logged.filter(line => line.startsWith('[single-frame] shot='));
      expect(timings).toHaveLength(2);
      expect(timings[0]).toContain('model=fal-ai/flux-2/klein/4b/edit');
      expect(timings[0]).toContain('request=still-1');
      expect(timings[0]).toMatch(/received=\S+ submitted=\+\d+\.\ds image=\+\d+\.\ds clip=\+\d+\.\ds played=\+\d+\.\ds/);
      expect(timings[0]).toContain('fal_total=2.4s');
    } finally {
      log.mockRestore();
      await manager.stopAll();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
    expect(run.state).toBe('stopped');
    // The run's temp directory does not outlive it.
    expect(closeSession).toHaveBeenCalled();
  }, 30_000);
});
