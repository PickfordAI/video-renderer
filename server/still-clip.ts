import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * PIC-1973: turn one generated still plus the kernel's own dialogue audio into a clip playout can
 * consume.
 *
 * The DSS has carried `talk.audio` all along and the planner has attached it to unsplit lines as
 * `dialogueAudioUrl`, but nothing ever consumed it: playout's audio is whatever the provider clip
 * contained. Single Frame has no provider audio at all, so the mux has to happen here, before the
 * clip reaches playout.
 *
 * Clips are written to a per-session temp directory and served over loopback rather than uploaded
 * anywhere: `parsePlayoutClip` already admits loopback HTTP, so the existing playout path needs no
 * new transport.
 */

export const STILL_CLIP_ROUTE_PREFIX = '/still-clips/';
const MAX_ASSET_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const CLIP_FRAME_RATE = 24;

export class StillClipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StillClipError';
  }
}

export interface StillClipRequest {
  shotId: string;
  imageUrl: string;
  /** The kernel's TTS for this line, or null when the payload carried none. */
  dialogueAudioUrl: string | null;
  holdSeconds: number;
  signal?: AbortSignal;
}

export interface StillClip {
  url: string;
  filePath: string;
  durationSeconds: number;
}

/** Only the renderer's own loopback playout may read a session's clips. */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.');
}

/**
 * One ffmpeg invocation: hold the still for the whole line and lay the dialogue over it.
 *
 * `-loop 1` makes the image an endless source and `-t` is what bounds the clip, so a long line
 * holds its one frame for as long as it needs — deliberately, per the 2026-09-14 decision. `apad`
 * covers the tail when the audio is shorter than the hold; `-shortest` is *not* used, because it
 * would cut the clip back to the audio and undo the floor.
 */
export function stillClipArgs(options: {
  imagePath: string;
  audioPath: string | null;
  holdSeconds: number;
  outputPath: string;
}): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-loop', '1', '-framerate', String(CLIP_FRAME_RATE), '-i', options.imagePath,
    ...(options.audioPath ? ['-i', options.audioPath] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']),
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p',
    '-af', 'aresample=48000,apad',
    '-t', String(options.holdSeconds),
    '-r', String(CLIP_FRAME_RATE),
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-profile:v', 'main', '-level:v', '3.1', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    options.outputPath,
  ];
}

function clipFileName(shotId: string): string {
  return `${shotId.replace(/[^A-Za-z0-9_-]/g, '_')}.mp4`;
}

function run(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { signal, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new StillClipError(`still clip synthesis failed: ${stderr?.toString().trim() || error.message}`));
      else resolve();
    });
  });
}

export interface StillClipStoreOptions {
  /** Loopback origin the renderer's operator server listens on; defaults to `http://127.0.0.1:$PORT`. */
  origin?: string;
  ffmpegPath?: string;
  fetchImpl?: typeof fetch;
  /** Mirrors playout's PICKFORD_KEEP_MEDIA: retain the temp directory for inspection. */
  keepMedia?: boolean;
  rootDir?: string;
}

export class StillClipSession {
  private readonly clips = new Map<string, string>();

  constructor(
    readonly token: string,
    private readonly directory: string,
    private readonly store: StillClipStore,
    private readonly options: StillClipStoreOptions,
  ) {}

  /** Absolute path of a clip this session owns, or null. Names are matched, never joined blindly. */
  resolve(fileName: string): string | null {
    return this.clips.get(fileName) ?? null;
  }

  async synthesize(request: StillClipRequest): Promise<StillClip> {
    if (!Number.isFinite(request.holdSeconds) || request.holdSeconds <= 0) {
      throw new StillClipError('still clip holdSeconds must be a positive number');
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const fileName = clipFileName(request.shotId);
    const imagePath = join(this.directory, `${fileName}.source.jpg`);
    const audioPath = request.dialogueAudioUrl ? join(this.directory, `${fileName}.source.mp3`) : null;
    await download(request.imageUrl, imagePath, fetchImpl, request.signal);
    if (audioPath) await download(request.dialogueAudioUrl!, audioPath, fetchImpl, request.signal);
    const outputPath = join(this.directory, fileName);
    await run(
      this.options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg',
      stillClipArgs({ imagePath, audioPath, holdSeconds: request.holdSeconds, outputPath }),
      request.signal,
    );
    if (!this.options.keepMedia) {
      await rm(imagePath, { force: true });
      if (audioPath) await rm(audioPath, { force: true });
    }
    this.clips.set(fileName, outputPath);
    return {
      url: `${(this.options.origin ?? defaultOrigin()).replace(/\/$/, '')}${STILL_CLIP_ROUTE_PREFIX}${this.token}/${fileName}`,
      filePath: outputPath,
      durationSeconds: request.holdSeconds,
    };
  }

  async close(): Promise<void> {
    this.clips.clear();
    this.store.forget(this.token);
    if (!this.options.keepMedia) await rm(this.directory, { recursive: true, force: true });
  }
}

async function download(url: string, destination: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<void> {
  const response = await fetchImpl(url, { redirect: 'follow', signal });
  if (!response.ok) throw new StillClipError(`still clip asset download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new StillClipError('still clip asset download returned an empty file');
  if (bytes.length > MAX_ASSET_DOWNLOAD_BYTES) {
    throw new StillClipError(`still clip asset is larger than ${MAX_ASSET_DOWNLOAD_BYTES} bytes`);
  }
  await writeFile(destination, bytes, { mode: 0o600 });
}

function defaultOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = Number.parseInt(env.PORT ?? '', 10);
  return `http://127.0.0.1:${Number.isInteger(parsed) && parsed > 0 ? parsed : 4173}`;
}

export class StillClipStore {
  private readonly sessions = new Map<string, StillClipSession>();

  constructor(private readonly options: StillClipStoreOptions = {}) {}

  /**
   * Open a session. The token — not the run id — is what appears in the URL, so a clip cannot be
   * guessed from a story or renderer identifier observed elsewhere.
   */
  open(): StillClipSession {
    const token = randomUUID();
    const root = this.options.rootDir ?? tmpdir();
    const session = new StillClipSession(token, join(root, `pickford-still-clips-${token}`), this, this.options);
    this.sessions.set(token, session);
    return session;
  }

  forget(token: string): void {
    this.sessions.delete(token);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(session => session.close()));
  }

  /**
   * Static route for synthesized clips. Loopback-only and token-scoped rather than relying on the
   * operator port's own auth, so it keeps working when RENDERER_ADMIN_TOKEN is configured — the
   * consumer is this process's own playout, which has no bearer token to present.
   */
  async serve(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const pathname = new URL(request.url ?? '/', 'http://local').pathname;
    if (!pathname.startsWith(STILL_CLIP_ROUTE_PREFIX)) return false;
    if (!isLoopbackAddress(request.socket.remoteAddress) || request.headers['x-forwarded-for'] || request.headers.forwarded) {
      response.writeHead(403, { 'Cache-Control': 'no-store' });
      response.end();
      return true;
    }
    const [token, fileName, ...rest] = pathname.slice(STILL_CLIP_ROUTE_PREFIX.length).split('/');
    const filePath = rest.length || !fileName || !/^[A-Za-z0-9_-]+\.mp4$/.test(fileName)
      ? null
      : this.sessions.get(token)?.resolve(fileName) ?? null;
    if (!filePath) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
      return true;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'Cache-Control': 'no-store' });
      response.end();
      return true;
    }
    const size = (await stat(filePath)).size;
    response.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') {
      response.end();
      return true;
    }
    await pipeline(createReadStream(filePath), response);
    return true;
  }
}

let shared: StillClipStore | null = null;

/**
 * The process-wide store. There is exactly one operator server serving the clip route, so the
 * sessions it can resolve and the URLs it hands out have to come from the same object.
 */
export function sharedStillClipStore(): StillClipStore {
  shared ??= new StillClipStore({ keepMedia: process.env.PICKFORD_KEEP_MEDIA === '1' });
  return shared;
}
