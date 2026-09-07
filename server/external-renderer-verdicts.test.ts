import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { ExternalRendererRunManager } from './external-renderer.js';
import type { PlayoutManager } from './playout.js';
import { generateVideo } from './fal.js';

vi.mock('./fal.js', () => ({ generateVideo: vi.fn(async () => ({ videoUrl: 'https://video.example/fixture.mp4' })) }));
type Json = Record<string, unknown>;
const rendererId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const assignmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture() {
  vi.stubEnv('FAL_KEY', 'fixture-key');
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const events: Json[] = [];
  const send = (message: Json) => { for (const socket of ws.clients) socket.send(JSON.stringify(message)); };
  ws.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString()); events.push(message);
    if (message.type === 'renderer.hello') send({ type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null, session_id: 'fixture-session', session_epoch: 1, lease_seconds: 30 });
    // The kernel fast-acks group-start progress; these tests are about the completion handshake.
    if (message.type === 'renderer.event' && message.event === 'command_progress') send({ type: 'renderer.event.verdict', protocol_version: 1, verdict: {
      verdict_id: `10000000-0000-4000-8000-${String(events.length).padStart(12, '0')}`, client_event_id: message.client_event_id, event_message_id: message.client_event_id,
      route: { tier: 'renderer-dev', environment: 'local', project_id: '11111111-1111-4111-8111-111111111111', story_run_id: '22222222-2222-4222-8222-222222222222', renderer_id: rendererId, stream_id: rendererId, renderer_lease_id: assignmentId, assignment_generation: 1 },
      correlation: { episode_id: 2, sequence: message.sequence, supplied_episode_id: 2, supplied_sequence: message.sequence },
      outcome: 'accepted', retryable: false, confirmed_frontier: message.sequence, missing_sequence_ranges: [], occurred_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
    } });
  }));
  let ended = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes('/story/?')) return Response.json({ active: !ended, running_key: ended ? null : 'fixture-story', errors: {} });
    if (String(url).endsWith('/login')) return Response.json({ access_token: 'fixture-token', websocket_url: `ws://127.0.0.1:${port}` });
    return Response.json({ renderer_id: rendererId }, { status: 202 });
  }));
  let played = -1;
  const enqueue = vi.fn();
  const stop = vi.fn(async () => undefined);
  const manager = new ExternalRendererRunManager({ start: vi.fn(async () => ({ sessionId: 'fixture-media', hlsUrl: '/hls/fixture.m3u8', enqueue, status: () => ({ state: 'streaming', playedThroughPosition: played }) })), stop } as unknown as PlayoutManager);
  const run = manager.start({
    baseUrl: `http://127.0.0.1:${port}`, environment: 'local', rendererId, credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', clientSecret: 'fixture-secret', rendererVersion: 'h3.test.v1.0', storyId: 42,
    registerManifest: false, initialImageUrl: 'https://images.example/initial.png', clipDurationSeconds: 5,
    rendererConfig: { model: 'fal-max-ref2v', continuity: 'none', concurrency: 2, maxBufferedSeconds: 30 },
    storyStatusBaseUrl: `http://127.0.0.1:${port}`, storyStatusToken: 'fixture-status',
  });
  await vi.waitFor(() => expect(run.state).toBe('running'));
  const dss = (sequence = 1) => ({ stream_id: rendererId, assignment_id: assignmentId, assignment_generation: 1, sequence, story_block_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', script: { sequence, episode_id: 2, command_groups: [{ id: `group-${sequence}`, commands: [{ command: 'talk', args: { character: 'Alex', dialogue: 'Hello Sam.', audio_duration: 5 } }] }] } });
  send(dss());
  await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
  const completion = () => events.find(event => event.type === 'renderer.event' && event.event === 'completed');
  const acknowledgements = () => events.filter(event => event.type === 'renderer.event.verdict.ack' && !String(event.verdict_id).startsWith('10000000-'));
  return {
    run, manager, stop, enqueue, send, dss, completion, acknowledgements,
    end: () => { ended = true; }, play: () => { played = 0; },
    verdict: (outcome = 'accepted') => ({ type: 'renderer.event.verdict', protocol_version: 1, verdict: {
      verdict_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', client_event_id: completion()!.client_event_id, event_message_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      route: { tier: 'renderer-dev', environment: 'local', project_id: '11111111-1111-4111-8111-111111111111', story_run_id: '22222222-2222-4222-8222-222222222222', renderer_id: rendererId, stream_id: rendererId, renderer_lease_id: assignmentId, assignment_generation: 1 },
      correlation: { episode_id: 2, sequence: 1, supplied_episode_id: 2, supplied_sequence: 1 },
      outcome, retryable: false, confirmed_frontier: 1, missing_sequence_ranges: [], occurred_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
    } }),
    close: async () => { await manager.stopAll(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve())); },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('StoryKernel completion verdict handshake', () => {
  it('finishes accepted playback before the verdict deadline, then writes the exact ACK before natural close', async () => {
    const test = await fixture();
    try {
      test.end();
      await vi.waitFor(() => expect(test.run.storyEndedAt).not.toBeNull(), { timeout: 1_500 });
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 10_000);
      await sleep(60);
      expect(test.run.state).toBe('running');
      expect(test.stop).not.toHaveBeenCalled();
      expect(test.completion()).toBeUndefined();
      test.send(test.dss(2));
      await sleep(30);
      expect(generateVideo).toHaveBeenCalledTimes(1);
      test.play();
      await vi.waitFor(() => expect(test.completion()).toBeDefined());
      expect(test.run.eventVerdicts).toMatchObject({ pending: 1, acknowledged: 1 });
      expect(test.stop).not.toHaveBeenCalled();
      test.send(test.verdict());
      await vi.waitFor(() => expect(test.acknowledgements()).toEqual([{ type: 'renderer.event.verdict.ack', protocol_version: 1, verdict_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', client_event_id: test.completion()!.client_event_id }]));
      await vi.waitFor(() => expect(test.run.state).toBe('ended'));
      expect(test.run.eventVerdicts).toMatchObject({ pending: 0, acknowledged: 2, refused: 0 });
      expect(test.stop).toHaveBeenCalledOnce();
    } finally { await test.close(); }
  });

  it('reports a bounded missing-verdict failure after playback without claiming successful natural completion', async () => {
    const test = await fixture();
    try {
      test.play();
      await vi.waitFor(() => expect(test.completion()).toBeDefined());
      test.end();
      await vi.waitFor(() => expect(test.run.storyEndedAt).not.toBeNull(), { timeout: 1_500 });
      const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 10_000);
      await vi.waitFor(() => expect(test.run.state).toBe('failed'));
      expect(test.run.failures.join(' ')).toContain('1 renderer verdicts pending');
      expect(test.run.eventVerdicts.pending).toBe(1);
      expect(test.acknowledgements()).toEqual([]);
    } finally { await test.close(); }
  });

  it('ACKs a negative authoritative verdict after recording refusal, then fails the run', async () => {
    const test = await fixture();
    try {
      test.play(); await vi.waitFor(() => expect(test.completion()).toBeDefined());
      test.send(test.verdict('behind_confirmed_frontier'));
      await vi.waitFor(() => expect(test.acknowledgements()).toHaveLength(1));
      await vi.waitFor(() => expect(test.run.state).toBe('failed'));
      expect(test.run.eventVerdicts).toMatchObject({ acknowledged: 2, pending: 0, refused: 1, lastOutcome: { outcome: 'behind_confirmed_frontier' } });
      expect(test.run.failures.join(' ')).toContain('behind_confirmed_frontier');
    } finally { await test.close(); }
  });

  it('reports transport rejection without sending a nonexistent verdict ACK', async () => {
    const test = await fixture();
    try {
      test.play(); await vi.waitFor(() => expect(test.completion()).toBeDefined());
      test.send({ type: 'renderer.event.rejected', protocol_version: 1, client_event_id: test.completion()!.client_event_id, code: 'idempotency_conflict', retryable: false, correlation_mismatch: null });
      await vi.waitFor(() => expect(test.run.state).toBe('failed'));
      expect(test.run.eventVerdicts).toMatchObject({ acknowledged: 1, pending: 1, refused: 1, lastTransportRejection: { code: 'idempotency_conflict' } });
      expect(test.acknowledgements()).toEqual([]);
    } finally { await test.close(); }
  });

  it('fails closed on continuing DSS when an earlier event has no authoritative verdict', async () => {
    const test = await fixture();
    try {
      test.play(); await vi.waitFor(() => expect(test.completion()).toBeDefined());
      const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 30_001);
      test.send({ type: 'renderer.heartbeat.accepted' });
      test.send(test.dss(2));
      await vi.waitFor(() => expect(test.run.state).toBe('failed'));
      expect(test.run.failures.join(' ')).toContain('verdict timed out');
      expect(generateVideo).toHaveBeenCalledTimes(1);
      expect(test.enqueue).toHaveBeenCalledTimes(1);
      expect(test.run.eventVerdicts.pending).toBe(1);
    } finally { await test.close(); }
  });

  it('stops local playout immediately without waiting for or fabricating a completion verdict', async () => {
    const test = await fixture();
    try {
      const stopped = test.manager.stopAll();
      expect(test.stop).toHaveBeenCalledOnce();
      await stopped;
      expect(test.run.state).toBe('stopped');
      expect(test.completion()).toBeUndefined();
      expect(test.acknowledgements()).toEqual([]);
    } finally { await test.close(); }
  });
});
