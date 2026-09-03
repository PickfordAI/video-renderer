import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  holdFrameArgs,
  normalizeClipArgs,
  parsePlayoutClip,
  PlayoutSession,
  publisherArgs,
  rebaseTransportStreamArgs,
} from './playout.js';

const clip = {
  position: 0,
  storyBlockId: 'beat-0',
  videoUrl: 'https://video.example/beat-0.mp4',
  durationSeconds: 5,
};

function successfulSpawn(..._args: unknown[]) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit('exit', 0, null));
  return child;
}

const successfulFetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
  status: 200,
  headers: { 'Content-Length': '3' },
}));

describe('H3 continuous playout', () => {
  it('validates clip enqueue payloads before FFmpeg sees them', () => {
    expect(parsePlayoutClip(clip)).toEqual(clip);
    expect(() => parsePlayoutClip({ ...clip, videoUrl: 'http://private/clip.mp4' })).toThrow('must use HTTPS');
    expect(parsePlayoutClip({ ...clip, videoUrl: 'http://127.0.0.1:9000/clip.mp4' }).videoUrl).toContain('127.0.0.1');
    expect(() => parsePlayoutClip({ ...clip, position: -1 })).toThrow('position');
  });

  it('normalizes every clip onto one fixed format and cumulative timeline', () => {
    const args = normalizeClipArgs(clip, '/tmp/clip.ts', 8);
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args).toContain('mpegts');
    expect(args.join(' ')).toContain('fps=24');
    expect(args.join(' ')).toContain('tpad=stop_mode=clone:stop_duration=5');
    expect(args.join(' ')).toContain('apad=pad_dur=5');
    expect(args.join(' ')).toContain('trim=duration=5');
    expect(args.join(' ')).toContain('setpts=PTS-STARTPTS+8/TB');
  });

  it('publishes the normalized transport stream to a stable RTSP path', () => {
    const args = publisherArgs('rtsp://relay:8554/h3-session');
    expect(args).toContain('-re');
    expect(args.slice(args.indexOf('-probesize'), args.indexOf('-probesize') + 4))
      .toEqual(['-probesize', '32768', '-analyzeduration', '0']);
    expect(args).not.toContain('copy');
    expect(args).toContain('fps=24,setpts=N/(24*TB)');
    expect(args).toContain('aresample=48000:async=1000:first_pts=0');
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args.at(-1)).toBe('rtsp://relay:8554/h3-session');
  });

  it('builds a silent one-second hold from the final source frame', () => {
    const args = holdFrameArgs('/tmp/clip.ts', '/tmp/hold.ts');
    expect(args).toContain('-sseof');
    expect(args).toContain('anullsrc=r=48000:cl=stereo');
    expect(args.join(' ')).toContain("reverse,select='eq(n,0)',loop=loop=23");
    expect(args.slice(args.indexOf('-frames:v'), args.indexOf('-frames:v') + 2)).toEqual(['-frames:v', '24']);
    expect(args.at(-1)).toBe('/tmp/hold.ts');
  });

  it('fast-remuxes each appended asset onto the live global timeline', () => {
    const args = rebaseTransportStreamArgs('/tmp/clip.ts', '/tmp/feed.ts', 12);
    expect(args).toContain('copy');
    expect(args.slice(args.indexOf('-output_ts_offset'), args.indexOf('-output_ts_offset') + 2))
      .toEqual(['-output_ts_offset', '12']);
    expect(args.slice(args.indexOf('-muxrate'), args.indexOf('-muxrate') + 2))
      .toEqual(['-muxrate', '2000000']);
    expect(args.at(-1)).toBe('/tmp/feed.ts');
  });

  it('waits for missing earlier positions before normalizing later clips', async () => {
    const spawnImpl = vi.fn(successfulSpawn);
    const session = new PlayoutSession({
      spawnImpl: spawnImpl as never,
      fetchImpl: successfulFetch as never,
      startupBufferClips: 99,
      startupWaitMs: 60_000,
    }, '00000000-0000-4000-8000-000000000001');
    await session.initialize();
    session.enqueue({ ...clip, position: 1, storyBlockId: 'beat-1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawnImpl).not.toHaveBeenCalled();

    session.enqueue(clip);
    await vi.waitFor(() => expect(session.status().normalizedClips).toBe(2));
    expect(spawnImpl).toHaveBeenCalledTimes(4);
    const calls = spawnImpl.mock.calls as unknown as [string, string[]][];
    const firstOutput = calls[0]?.[1]?.at(-1);
    const firstInputIndex = calls[0]?.[1]?.indexOf('-i') ?? -1;
    const secondArgs = calls[2]?.[1] ?? [];
    expect(String(firstOutput)).toContain('000000.ts');
    expect(calls[0]?.[1]?.[firstInputIndex + 1]).toContain('000000.source.mp4');
    expect(secondArgs.join(' ')).toContain('setpts=PTS-STARTPTS+0/TB');
    await session.stop();
  });

  it('can skip a failed timeline position without stalling later clips', async () => {
    const spawnImpl = vi.fn(successfulSpawn);
    const session = new PlayoutSession({
      spawnImpl: spawnImpl as never,
      fetchImpl: successfulFetch as never,
      startupBufferClips: 99,
      startupWaitMs: 60_000,
    }, '00000000-0000-4000-8000-000000000002');
    await session.initialize();
    session.enqueue({ ...clip, position: 1, storyBlockId: 'beat-1' });
    session.skip(0);
    await vi.waitFor(() => expect(session.status().normalizedClips).toBe(1));
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    await session.stop();
  });

  it('retains a useful error when the generated clip cannot be downloaded', async () => {
    const session = new PlayoutSession({
      fetchImpl: vi.fn(async () => new Response('signed URL expired', { status: 403 })) as never,
      startupBufferClips: 99,
    }, '00000000-0000-4000-8000-000000000003');
    await session.initialize();
    session.enqueue(clip);
    await vi.waitFor(() => expect(session.status().state).toBe('error'));
    expect(session.status().error).toContain('clip download failed (403): signed URL expired');
    await session.stop();
  });

  it('reopens the publisher when a generation gap causes an EPIPE', async () => {
    let publisherCount = 0;
    const spawnImpl = vi.fn((_executable: string, args: string[]) => {
      const isPublisher = args.at(-1)?.startsWith('rtsp://');
      if (!isPublisher) {
        writeFileSync(args.at(-1)!, new Uint8Array([1, 2, 3]));
        return successfulSpawn();
      }

      publisherCount += 1;
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      let receivedData = false;
      child.stdin.on('data', () => {
        if (receivedData) return;
        receivedData = true;
        if (publisherCount === 1) {
          queueMicrotask(() => child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
        } else {
          child.stderr.write('out_time_us=1000000\n');
        }
      });
      return child;
    });
    const session = new PlayoutSession({
      spawnImpl: spawnImpl as never,
      fetchImpl: successfulFetch as never,
      startupBufferClips: 1,
      publisherRestartDelayMs: 0,
    }, '00000000-0000-4000-8000-000000000004');
    await session.initialize();
    session.enqueue(clip);

    await vi.waitFor(() => expect(publisherCount).toBe(2));
    await vi.waitFor(() => expect(session.status().state).toBe('streaming'));
    expect(session.status().error).toBeNull();
    await session.stop();
  });

  it('holds the last frame without advancing the played-through cursor when runway is exhausted', async () => {
    let publisherWrites = 0;
    const spawnImpl = vi.fn((_executable: string, args: string[]) => {
      const isPublisher = args.at(-1)?.startsWith('rtsp://');
      if (!isPublisher) {
        writeFileSync(args.at(-1)!, new Uint8Array([1, 2, 3]));
        return successfulSpawn();
      }

      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      child.stdin.on('data', () => {
        publisherWrites += 1;
        if (publisherWrites === 1) child.stderr.write('out_time_us=5000000\n');
      });
      return child;
    });
    const session = new PlayoutSession({
      spawnImpl: spawnImpl as never,
      fetchImpl: successfulFetch as never,
      startupBufferClips: 1,
      audienceDelaySeconds: 0,
      holdRunwaySeconds: 0,
      holdPollMs: 1,
    }, '00000000-0000-4000-8000-000000000006');
    await session.initialize();
    session.enqueue(clip);

    await vi.waitFor(() => expect(publisherWrites).toBeGreaterThanOrEqual(2));
    expect(session.status().playedThroughPosition).toBe(0);
    expect(session.status().currentPosition).toBeNull();
    await session.stop();
  });

  it('keeps cumulative playback progress after reopening at a later clip', async () => {
    let publisherCount = 0;
    let firstPublisher: EventEmitter | null = null;
    const spawnImpl = vi.fn((_executable: string, args: string[]) => {
      const isPublisher = args.at(-1)?.startsWith('rtsp://');
      if (!isPublisher) {
        writeFileSync(args.at(-1)!, new Uint8Array([1, 2, 3]));
        return successfulSpawn();
      }

      publisherCount += 1;
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      if (publisherCount === 1) firstPublisher = child;
      child.stdin.on('data', () => {
        child.stderr.write(`out_time_us=${publisherCount === 1 ? 4000000 : 1000000}\n`);
      });
      return child;
    });
    const session = new PlayoutSession({
      spawnImpl: spawnImpl as never,
      fetchImpl: successfulFetch as never,
      startupBufferClips: 2,
      publisherRestartDelayMs: 0,
    }, '00000000-0000-4000-8000-000000000005');
    await session.initialize();
    session.enqueue(clip);
    session.enqueue({ ...clip, position: 1, storyBlockId: 'beat-1' });
    await vi.waitFor(() => expect(session.status().outputSeconds).toBe(4));
    await vi.waitFor(() => expect(session.status().normalizedClips).toBe(0));

    (firstPublisher as EventEmitter | null)?.emit('exit', 1, null);
    await vi.waitFor(() => expect(session.status().state).toBe('buffering'));
    session.enqueue({ ...clip, position: 2, storyBlockId: 'beat-2' });
    session.enqueue({ ...clip, position: 3, storyBlockId: 'beat-3' });

    await vi.waitFor(() => expect(publisherCount).toBe(2));
    await vi.waitFor(() => expect(session.status().outputSeconds).toBe(5));
    expect(session.status().state).toBe('streaming');
    await session.stop();
  });
});
