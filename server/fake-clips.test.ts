import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import { ExternalRendererRunManager } from './external-renderer.js';
import { FakeClipPlayoutManager, fakeClipFailureAfter, fakeClipsEnabled } from './fake-clips.js';

const rendererId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storyBlockId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function config(baseUrl: string, environment = 'local') {
  return {
    baseUrl,
    environment,
    rendererId,
    credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    clientSecret: 'fixture-secret',
    rendererVersion: 'h3.test.v1.0',
    registerManifest: false,
    storyId: 42,
    roomId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    roomShortlink: 'TEST',
    storyMessageChannelId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    roomMainMessageChannelId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    storyConfig: {
      base_structure: 'MINIMAX',
      evd_id: '11111111-1111-4111-8111-111111111111',
      message_channel_ids: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
    },
  };
}

function dss(sequence: number) {
  return {
    stream_id: rendererId,
    assignment_id: 'assignment',
    assignment_generation: 1,
    sequence,
    story_block_id: storyBlockId,
    script: {
      sequence,
      command_groups: [{
        id: `group-${sequence}`,
        commands: [{ command: 'Talk', args: { character: 'Alex', dialogue: `Line ${sequence}.` } }],
      }],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('local fake clips', () => {
  it('parses the opt-in and bounded one-shot failure settings', () => {
    expect(fakeClipsEnabled({ PICKFORD_FAKE_CLIPS: '1' })).toBe(true);
    expect(fakeClipsEnabled({ PICKFORD_FAKE_CLIPS: 'true' })).toBe(false);
    expect(fakeClipFailureAfter({})).toBeNull();
    expect(fakeClipFailureAfter({ PICKFORD_FAKE_CLIPS_FAIL_ONCE_AFTER: '2' })).toBe(2);
    expect(() => fakeClipFailureAfter({ PICKFORD_FAKE_CLIPS_FAIL_ONCE_AFTER: '0' })).toThrow('1 to 100');
  });

  it('fails once after two synthetic clips, cleans up, and permits the next run', async () => {
    const http = createServer();
    const ws = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    const events: Record<string, unknown>[] = [];
    ws.on('connection', socket => socket.on('message', raw => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      events.push(event);
      if (event.type === 'renderer.hello') {
        socket.send(JSON.stringify({
          type: 'renderer.welcome', stream_id: rendererId, media_ingest_url: null,
          session_id: `session-${events.length}`, session_epoch: 1, lease_seconds: 30,
        }));
      } else if (event.type === 'renderer.event') {
        socket.send(JSON.stringify({
          type: 'renderer.event.verdict', protocol_version: 1,
          verdict: {
            verdict_id: `verdict-${event.client_event_id}`,
            client_event_id: event.client_event_id,
            route: {
              renderer_id: rendererId, stream_id: rendererId,
              renderer_lease_id: event.assignment_id,
              assignment_generation: event.assignment_generation,
            },
            correlation: { episode_id: 42, sequence: event.sequence },
            outcome: 'accepted', confirmed_frontier: event.sequence,
          },
        }));
      }
    }));
    let starts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/login')) {
        return Response.json({ access_token: 'fixture-token', websocket_url: `ws://127.0.0.1:${port}` });
      }
      starts += 1;
      const frames = starts === 1 ? [dss(1), dss(2), dss(3)] : [dss(1)];
      for (const socket of ws.clients) for (const frame of frames) socket.send(JSON.stringify(frame));
      return Response.json({ renderer_id: rendererId }, { status: 202 });
    }));

    const manager = new ExternalRendererRunManager(
      new FakeClipPlayoutManager(),
      { fakeClips: true, fakeFailureAfterClips: 2 },
    );
    const first = manager.start(config(`http://127.0.0.1:${port}`));
    try {
      await vi.waitFor(() => expect(first.state).toBe('failed'));
      expect(first.fakeClips).toBe(true);
      expect(first.clipsRendered).toBe(2);
      expect(first.clips).toHaveLength(3);
      expect(first.clips.slice(0, 2).every(clip => clip.playedAt !== null && clip.generationMs === 0)).toBe(true);
      expect(first.clips[2]).toMatchObject({ readyAt: null, playedAt: null });
      expect(first.failures).toEqual(['Synthetic local renderer failure after 2 fake clips']);
      expect(first.eventVerdicts).toMatchObject({ pending: 0, refused: 0, ignored: 0 });
      expect(first.hlsUrl).toMatch(/^fake:\/\/pickford-clips\//);
      expect(events.filter(event => event.event === 'completed')).toHaveLength(2);
      expect(events.some(event => event.event === 'script_started')).toBe(true);

      await manager.stop(first.runId);
      const second = manager.start(config(`http://127.0.0.1:${port}`));
      await vi.waitFor(() => expect(second.dssCommandsRendered).toBe(1));
      expect(second.state).toBe('running');
      expect(second.fakeClips).toBe(true);
      expect(second.failures).toEqual([]);
      await manager.stop(second.runId);
      expect(second.state).toBe('stopped');
    } finally {
      await manager.stopAll();
      for (const socket of ws.clients) socket.terminate();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });

  it('refuses fake clips outside a loopback local run', () => {
    const manager = new ExternalRendererRunManager(new FakeClipPlayoutManager(), { fakeClips: true });
    expect(() => manager.start(config('https://dev.pickford.ai', 'dev'))).toThrow('restricted to a loopback local renderer run');
  });

  it('accepts a loopback unified stack whose platform environment is dev', async () => {
    const manager = new ExternalRendererRunManager(new FakeClipPlayoutManager(), { fakeClips: true });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fixture stop'));
    const run = manager.start(config('http://127.0.0.1:8893', 'dev'));
    await vi.waitFor(() => expect(run.state).toBe('failed'));
    expect(fetch).toHaveBeenCalled();
  });
});
