import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parsePlayoutClip } from './playout.js';
import { isLoopbackAddress, StillClipError, StillClipStore, stillClipArgs } from './still-clip.js';

const exec = promisify(execFile);

let workspace: string;
let framePath: string;
let dialoguePath: string;

/** Fixtures are synthesized here rather than committed: no unlicensed media, no story content. */
async function ffmpeg(args: string[]): Promise<void> {
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 8 * 1024 * 1024 });
}

async function probe(path: string): Promise<{ duration: number; codecs: string[] }> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type',
    '-of', 'json', path,
  ], { maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { format: { duration: string }; streams: { codec_type: string }[] };
  return { duration: Number(parsed.format.duration), codecs: parsed.streams.map(stream => stream.codec_type) };
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'still-clip-test-'));
  framePath = join(workspace, 'frame.jpg');
  dialoguePath = join(workspace, 'dialogue.mp3');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=slateblue:s=1280x720:d=1', '-frames:v', '1', framePath]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=7.3', '-c:a', 'libmp3lame', dialoguePath]);
}, 60_000);

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Serves the synthesized fixtures in place of fal and the kernel's TTS bucket. */
function assetFetch(): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/frame.jpg')) return new Response(await readFile(framePath));
    if (url.endsWith('/dialogue.mp3')) return new Response(await readFile(dialoguePath));
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function store(overrides: Record<string, unknown> = {}) {
  return new StillClipStore({
    origin: 'http://127.0.0.1:4173',
    rootDir: workspace,
    fetchImpl: assetFetch(),
    ...overrides,
  });
}

describe('synthesizing a held-frame clip', () => {
  it('lays the kernel dialogue over one held frame for the requested hold', async () => {
    const session = store().open();
    try {
      const clip = await session.synthesize({
        shotId: 'block:group:0',
        imageUrl: 'https://v3.fal.media/frame.jpg',
        dialogueAudioUrl: 'https://audio.example/dialogue.mp3',
        holdSeconds: 8,
      });
      const probed = await probe(clip.filePath);
      expect(probed.codecs.sort()).toEqual(['audio', 'video']);
      // The 7.3 s line is padded up to the hold rather than cutting the clip short.
      expect(probed.duration).toBeGreaterThanOrEqual(7.9);
      expect(probed.duration).toBeLessThanOrEqual(8.3);
      expect(clip.durationSeconds).toBe(8);
      expect(clip.url).toMatch(/^http:\/\/127\.0\.0\.1:4173\/still-clips\/[0-9a-f-]{36}\/block_group_0\.mp4$/);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('produces a silent clip at the floor when a payload carried no audio', async () => {
    const session = store().open();
    try {
      const clip = await session.synthesize({
        shotId: 'block:group:1', imageUrl: 'https://v3.fal.media/frame.jpg', dialogueAudioUrl: null, holdSeconds: 5,
      });
      const probed = await probe(clip.filePath);
      expect(probed.codecs.sort()).toEqual(['audio', 'video']);
      expect(probed.duration).toBeGreaterThanOrEqual(4.9);
      expect(probed.duration).toBeLessThanOrEqual(5.3);
    } finally {
      await session.close();
    }
  }, 60_000);

  // The 2026-09-14 decision: hold one frame for the whole line, however long. A 40 s line is one
  // clip, not three provider-sized fragments.
  it('holds a single frame across a line far longer than a provider clip', async () => {
    const session = store().open();
    try {
      const clip = await session.synthesize({
        shotId: 'block:group:2', imageUrl: 'https://v3.fal.media/frame.jpg',
        dialogueAudioUrl: 'https://audio.example/dialogue.mp3', holdSeconds: 40,
      });
      const probed = await probe(clip.filePath);
      expect(probed.duration).toBeGreaterThanOrEqual(39.5);
      expect(probed.duration).toBeLessThanOrEqual(40.5);
      // Playout admits it unchanged: loopback HTTP is already allowed, and the 15 s cap is gone.
      expect(parsePlayoutClip({ position: 0, storyBlockId: 'block', videoUrl: clip.url, durationSeconds: 40 }))
        .toMatchObject({ videoUrl: clip.url, durationSeconds: 40 });
    } finally {
      await session.close();
    }
  }, 120_000);

  it('refuses a nonsense hold and reports an asset it cannot download', async () => {
    const session = store().open();
    try {
      await expect(session.synthesize({ shotId: 'a', imageUrl: 'https://v3.fal.media/frame.jpg', dialogueAudioUrl: null, holdSeconds: 0 }))
        .rejects.toBeInstanceOf(StillClipError);
      await expect(session.synthesize({ shotId: 'b', imageUrl: 'https://v3.fal.media/missing.jpg', dialogueAudioUrl: null, holdSeconds: 5 }))
        .rejects.toThrow(/asset download failed \(404\)/);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('never cuts the clip back to the audio length', () => {
    const args = stillClipArgs({ imagePath: 'f.jpg', audioPath: 'd.mp3', holdSeconds: 12, outputPath: 'o.mp4' });
    expect(args).toContain('-t');
    expect(args[args.indexOf('-t') + 1]).toBe('12');
    expect(args).not.toContain('-shortest');
    expect(args.join(' ')).toContain('apad');
    expect(stillClipArgs({ imagePath: 'f.jpg', audioPath: null, holdSeconds: 5, outputPath: 'o.mp4' }).join(' '))
      .toContain('anullsrc=r=48000:cl=stereo');
  });
});

describe('serving synthesized clips to playout', () => {
  let server: Server;
  let origin: string;
  let clipStore: StillClipStore;

  beforeAll(async () => {
    clipStore = store();
    server = createServer((request, response) => {
      void clipStore.serve(request, response).then(handled => {
        if (!handled) { response.writeHead(404); response.end(); }
      }).catch(() => response.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await clipStore.closeAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('serves a session clip over loopback and forgets it after the session closes', async () => {
    const session = clipStore.open();
    const clip = await session.synthesize({
      shotId: 'block:group:0', imageUrl: 'https://v3.fal.media/frame.jpg', dialogueAudioUrl: null, holdSeconds: 5,
    });
    const url = clip.url.replace('http://127.0.0.1:4173', origin);

    const served = await fetch(url);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('video/mp4');
    expect((await served.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    await session.close();
    expect((await fetch(url)).status).toBe(404);
  }, 60_000);

  it('refuses unknown tokens and path traversal', async () => {
    expect((await fetch(`${origin}/still-clips/00000000-0000-4000-8000-000000000000/shot.mp4`)).status).toBe(404);
    expect((await fetch(`${origin}/still-clips/token/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await fetch(`${origin}/still-clips/token/nested/shot.mp4`)).status).toBe(404);
    // Anything outside the route is left to the rest of the server.
    expect((await fetch(`${origin}/api/health`)).status).toBe(404);
  });

  it('treats only loopback peers as local', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.4')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('playout clip bounds', () => {
  const clip = { position: 0, storyBlockId: 'block', videoUrl: 'https://cdn.example/clip.mp4' };

  it('accepts a held frame far longer than a provider clip but still rejects nonsense', () => {
    expect(parsePlayoutClip({ ...clip, durationSeconds: 120 })).toMatchObject({ durationSeconds: 120 });
    expect(() => parsePlayoutClip({ ...clip, durationSeconds: 4 })).toThrow('5 to 180');
    expect(() => parsePlayoutClip({ ...clip, durationSeconds: 181 })).toThrow('5 to 180');
  });

  it('still refuses a non-loopback HTTP clip source', () => {
    expect(() => parsePlayoutClip({ ...clip, videoUrl: 'http://media.example/clip.mp4', durationSeconds: 5 }))
      .toThrow('must use HTTPS');
    expect(parsePlayoutClip({ ...clip, videoUrl: 'http://127.0.0.1:4173/still-clips/t/s.mp4', durationSeconds: 5 }))
      .toMatchObject({ videoUrl: 'http://127.0.0.1:4173/still-clips/t/s.mp4' });
  });
});
