import { publicMediaBaseUrl } from './public-origin.js';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface PlayoutClipInput {
  position: number;
  storyBlockId: string;
  videoUrl: string;
  durationSeconds: number;
  /** Kernel-commanded pause (a timed control such as `fade` or `delay`) the audience must see
   *  before this clip starts. Fed as hold frames on the timeline, so it is never a stall. */
  leadInSeconds?: number;
}

/** Longest commanded pause a single clip may carry; longer ones are a DSS authoring error. */
export const MAX_LEAD_IN_SECONDS = 60;

export interface PlayoutStatus {
  sessionId: string;
  hlsUrl: string;
  state: 'buffering' | 'starting' | 'streaming' | 'stopped' | 'error';
  normalizedClips: number;
  pendingClips: number;
  currentPosition: number | null;
  playedThroughPosition: number;
  outputSeconds: number;
  /** Output-timeline second the audience is watching now: encoder progress minus relay delay. */
  audienceSeconds: number;
  /** Total stall hold-frame seconds fed so far: dead air the audience saw between real clips. */
  holdSeconds: number;
  /** Total kernel-commanded lead-in seconds fed so far; deliberate pauses, not dead air. */
  leadInSeconds: number;
  error: string | null;
  /** Absolute media directory, reported only while opt-in retention keeps it after the run. */
  mediaDir: string | null;
  finalMp4: string | null;
}

/** Where one real clip landed on the output timeline, and how much hold filler preceded it. */
export interface PlayoutClipBoundary {
  position: number;
  storyBlockId: string;
  /** Output-timeline second at which this clip's first frame was fed to the publisher. */
  startSeconds: number;
  endSeconds: number;
  /** Stall hold-frame seconds fed between the previous real clip's end and this clip's start. */
  holdSecondsBefore: number;
  /** Kernel-commanded lead-in seconds fed before this clip, on top of any stall hold. */
  leadInSecondsBefore: number;
}

interface NormalizedClip extends PlayoutClipInput {
  filePath: string;
  holdFilePath: string;
}

interface PublishedBoundary extends PlayoutClipInput {
  startSeconds: number;
  endSeconds: number;
  holdSecondsBefore: number;
  leadInSecondsBefore: number;
}

interface PlayoutOptions {
  ffmpegPath?: string;
  rtspBaseUrl?: string;
  hlsBaseUrl?: string;
  startupBufferClips?: number;
  startupWaitMs?: number;
  audienceDelaySeconds?: number;
  fetchImpl?: typeof fetch;
  downloadTimeoutMs?: number;
  spawnImpl?: typeof spawn;
  publisherRestartDelayMs?: number;
  holdRunwaySeconds?: number;
  holdPollMs?: number;
  keepMedia?: boolean;
}

export function keepMediaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PICKFORD_KEEP_MEDIA === '1';
}

export function concatToMp4Args(listPath: string, outputPath: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    // Every retained segment was normalized to identical codec parameters, so the
    // review copy needs no re-encode; only the ADTS-to-ASC audio rewrite for MP4.
    '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    outputPath,
  ];
}

const MAX_CLIP_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_CONSECUTIVE_PUBLISHER_RESTARTS = 3;
const HOLD_CLIP_SECONDS = 1;

function requiredClip(value: unknown): PlayoutClipInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('clip body must be an object');
  const body = value as Record<string, unknown>;
  const position = body.position;
  const storyBlockId = typeof body.storyBlockId === 'string' ? body.storyBlockId.trim() : '';
  const videoUrl = typeof body.videoUrl === 'string' ? body.videoUrl.trim() : '';
  const durationSeconds = body.durationSeconds;
  if (!Number.isInteger(position) || (position as number) < 0 || (position as number) > 10_000) {
    throw new Error('clip position must be an integer from 0 to 10000');
  }
  if (!storyBlockId || storyBlockId.length > 300) throw new Error('storyBlockId is required');
  let parsedVideoUrl: URL;
  try {
    parsedVideoUrl = new URL(videoUrl);
  } catch {
    throw new Error('clip videoUrl must be a valid URL');
  }
  const isLoopbackHttp = parsedVideoUrl.protocol === 'http:'
    && ['127.0.0.1', '::1', 'localhost'].includes(parsedVideoUrl.hostname);
  if (parsedVideoUrl.protocol !== 'https:' && !isLoopbackHttp) {
    throw new Error('clip videoUrl must use HTTPS (loopback HTTP is allowed for local testing)');
  }
  if (typeof durationSeconds !== 'number' || durationSeconds < 5 || durationSeconds > 15) {
    throw new Error('clip durationSeconds must be from 5 to 15');
  }
  const leadInSeconds = body.leadInSeconds;
  if (leadInSeconds !== undefined) {
    if (typeof leadInSeconds !== 'number' || !Number.isFinite(leadInSeconds) || leadInSeconds < 0 || leadInSeconds > MAX_LEAD_IN_SECONDS) {
      throw new Error(`clip leadInSeconds must be from 0 to ${MAX_LEAD_IN_SECONDS}`);
    }
  }
  const clip: PlayoutClipInput = { position: position as number, storyBlockId, videoUrl, durationSeconds };
  if (leadInSeconds) clip.leadInSeconds = leadInSeconds;
  return clip;
}

export function parsePlayoutClip(value: unknown): PlayoutClipInput {
  return requiredClip(value);
}

export function normalizeClipArgs(input: PlayoutClipInput, outputPath: string, offsetSeconds: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input.videoUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    // Fal clips can end a few frames—or an audio tail—before their requested
    // duration. Fill both streams before trimming so every clip occupies its
    // complete timeline slot and concatenation never introduces a PTS hole.
    '-vf', `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,fps=24,format=yuv420p,tpad=stop_mode=clone:stop_duration=${input.durationSeconds},trim=duration=${input.durationSeconds},setpts=PTS-STARTPTS+${offsetSeconds}/TB`,
    '-af', `aresample=48000,apad=pad_dur=${input.durationSeconds},atrim=duration=${input.durationSeconds},asetpts=PTS-STARTPTS+${offsetSeconds}/TB`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-profile:v', 'main', '-level:v', '3.1', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-muxdelay', '0', '-muxpreload', '0', '-mpegts_copyts', '1',
    '-f', 'mpegts', outputPath,
  ];
}

export function holdFrameArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    // Decode a full keyframe interval, then reverse-select its final valid
    // frame. Seeking only a few milliseconds from EOF can land after the last
    // IDR and produce an H.264 track with no decodable video frames.
    '-sseof', '-1', '-i', inputPath,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', "reverse,select='eq(n,0)',loop=loop=23:size=1:start=0,setpts=N/(24*TB),format=yuv420p",
    '-af', `atrim=duration=${HOLD_CLIP_SECONDS},asetpts=PTS-STARTPTS`,
    '-frames:v', '24',
    '-t', String(HOLD_CLIP_SECONDS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-profile:v', 'main', '-level:v', '3.1', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'mpegts', outputPath,
  ];
}

export function rebaseTransportStreamArgs(
  inputPath: string,
  outputPath: string,
  offsetSeconds: number,
): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    '-output_ts_offset', String(offsetSeconds),
    // A frozen frame compresses to only a few KB. Pad every feed asset to a
    // constant rate so the OS pipe cannot silently queue several seconds of
    // holds ahead of a newly normalized real clip.
    '-muxrate', '2000000',
    '-muxdelay', '0', '-muxpreload', '0', '-mpegts_copyts', '1',
    '-f', 'mpegts', outputPath,
  ];
}

export function publisherArgs(rtspUrl: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostats',
    '-re', '-fflags', '+genpts+discardcorrupt',
    // The input is already normalized MPEG-TS. Bound probing so FFmpeg starts
    // publishing the opening clip instead of waiting for a second clip's bytes.
    '-probesize', '32768', '-analyzeduration', '0', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?',
    // Each source clip was encoded independently. Rebuild one continuous
    // frame/sample clock and GOP cadence so HLS never sees a new timeline or
    // a missing one-second keyframe at clip boundaries.
    '-vf', 'fps=24,setpts=N/(24*TB)',
    '-af', 'aresample=48000:async=1000:first_pts=0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-profile:v', 'main', '-level:v', '3.1', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-f', 'rtsp', '-rtsp_transport', 'tcp',
    '-progress', 'pipe:2', rtspUrl,
  ];
}

async function runProcess(
  executable: string,
  args: string[],
  spawnImpl: typeof spawn,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', (chunk: Buffer) => { errorText = `${errorText}${chunk.toString()}`.slice(-4_000); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg normalization failed (${signal ?? code ?? 'unknown'}): ${errorText.trim()}`));
    });
  });
}

async function downloadClip(
  videoUrl: string,
  destination: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchImpl(videoUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const detail = (await response.text()).trim().slice(0, 300);
        throw new Error(`clip download failed (${response.status})${detail ? `: ${detail}` : ''}`);
      }
      const declaredBytes = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_CLIP_DOWNLOAD_BYTES) {
        throw new Error(`clip download is larger than ${MAX_CLIP_DOWNLOAD_BYTES} bytes`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw new Error('clip download returned an empty file');
      if (bytes.length > MAX_CLIP_DOWNLOAD_BYTES) {
        throw new Error(`clip download is larger than ${MAX_CLIP_DOWNLOAD_BYTES} bytes`);
      }
      await writeFile(destination, bytes);
      return;
    } catch (cause) {
      lastError = cause;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : 'unknown download failure';
  throw new Error(`could not download generated clip after 2 attempts: ${detail}`);
}

async function writeToStream(destination: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    destination.write(chunk, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function appendFileToStream(
  filePath: string,
  destination: NodeJS.WritableStream,
  paceSeconds = 0,
): Promise<void> {
  const fileSize = paceSeconds > 0 ? (await stat(filePath)).size : 0;
  // MPEG-TS packets are 188 bytes. Twenty slices makes a one-second hold
  // interruptible within about 50ms while keeping every write packet-aligned.
  const pacedChunkSize = fileSize > 0
    ? Math.max(188, Math.ceil(fileSize / 20 / 188) * 188)
    : undefined;
  const source = createReadStream(filePath, pacedChunkSize ? { highWaterMark: pacedChunkSize } : undefined);
  const startedAt = Date.now();
  let writtenBytes = 0;
  let rejectDestination: ((error: Error) => void) | null = null;
  const destinationError = new Promise<never>((_resolve, reject) => { rejectDestination = reject; });
  const onDestinationError = (error: Error) => rejectDestination?.(error);
  destination.once('error', onDestinationError);
  try {
    await Promise.race([
      (async () => {
        for await (const chunk of source) {
          await writeToStream(destination, chunk as Buffer);
          if (paceSeconds <= 0 || fileSize <= 0) continue;
          writtenBytes += chunk.length;
          const targetElapsedMs = (writtenBytes / fileSize) * paceSeconds * 1_000;
          const remainingMs = targetElapsedMs - (Date.now() - startedAt);
          if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
        }
      })(),
      destinationError,
    ]);
  } catch (error) {
    source.destroy();
    throw error;
  } finally {
    destination.removeListener('error', onDestinationError);
  }
}

export class PlayoutSession {
  readonly sessionId: string;
  readonly hlsUrl: string;
  private readonly pathName: string;
  private readonly tempRoot: string;
  private readonly ffmpegPath: string;
  private readonly rtspUrl: string;
  private readonly startupBufferClips: number;
  private readonly startupWaitMs: number;
  private readonly audienceDelaySeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly downloadTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly publisherRestartDelayMs: number;
  private readonly holdRunwaySeconds: number;
  private readonly holdPollMs: number;
  private readonly keepMedia: boolean;
  private readonly retainedFilePaths: string[] = [];
  private finalMp4: string | null = null;
  private readonly pending = new Map<number, PlayoutClipInput>();
  private readonly normalized = new Map<number, NormalizedClip>();
  private readonly skipped = new Set<number>();
  private readonly boundaries: PublishedBoundary[] = [];
  private nextNormalizePosition = 0;
  private nextPublishPosition = 0;
  private fedSeconds = 0;
  private holdSeconds = 0;
  private holdSecondsSinceClip = 0;
  private leadInSeconds = 0;
  private outputSeconds = 0;
  private state: PlayoutStatus['state'] = 'buffering';
  private error: string | null = null;
  private publisher: ChildProcessWithoutNullStreams | null = null;
  private publisherTimelineOffsetSeconds = 0;
  private publisherRestartAttempts = 0;
  private publisherRestartTimer: NodeJS.Timeout | null = null;
  private normalizeRunning = false;
  private feedRunning = false;
  private stopped = false;
  private startupTimer: NodeJS.Timeout | null = null;
  private feedTimer: NodeJS.Timeout | null = null;
  private feedWake: (() => void) | null = null;
  private activeHoldFilePath: string | null = null;

  constructor(options: PlayoutOptions = {}, sessionId = randomUUID()) {
    this.sessionId = sessionId;
    this.pathName = `h3-${sessionId}`;
    this.tempRoot = join(tmpdir(), `pickford-h3-playout-${sessionId}`);
    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    const rtspBase = (options.rtspBaseUrl ?? process.env.MEDIA_RELAY_RTSP_BASE_URL ?? 'rtsp://127.0.0.1:8554').replace(/\/$/, '');
    const hlsBase = (options.hlsBaseUrl ?? publicMediaBaseUrl()).replace(/\/$/, '');
    this.rtspUrl = `${rtspBase}/${this.pathName}`;
    this.hlsUrl = `${hlsBase}/${this.pathName}/index.m3u8`;
    this.startupBufferClips = Math.max(1, options.startupBufferClips ?? 2);
    this.startupWaitMs = Math.max(0, options.startupWaitMs ?? 15_000);
    this.audienceDelaySeconds = Math.max(
      0,
      options.audienceDelaySeconds
        ?? Number.parseFloat(process.env.MEDIA_RELAY_AUDIENCE_DELAY_SECONDS ?? '3'),
    );
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.downloadTimeoutMs = Math.max(1_000, options.downloadTimeoutMs ?? 120_000);
    this.publisherRestartDelayMs = Math.max(0, options.publisherRestartDelayMs ?? 250);
    // FFmpeg's progress timestamp trails the final muxed packet by roughly
    // 0.7s. Keep one second of runway so the relay never reaches its idle
    // timeout, without building several seconds of filler ahead of a real clip.
    this.holdRunwaySeconds = Math.max(0, options.holdRunwaySeconds ?? 1);
    this.holdPollMs = Math.max(1, options.holdPollMs ?? 250);
    this.keepMedia = options.keepMedia ?? keepMediaEnabled();
  }

  async initialize(): Promise<void> {
    await mkdir(this.tempRoot, { recursive: true });
  }

  enqueue(value: unknown): PlayoutClipInput {
    if (this.stopped) throw new Error('playout session is stopped');
    const clip = requiredClip(value);
    if (clip.position < this.nextNormalizePosition || this.pending.has(clip.position) || this.normalized.has(clip.position)) {
      return clip;
    }
    this.pending.set(clip.position, clip);
    void this.normalizeAvailable();
    return clip;
  }

  skip(position: unknown): void {
    if (this.stopped) throw new Error('playout session is stopped');
    if (!Number.isInteger(position) || (position as number) < 0 || (position as number) > 10_000) {
      throw new Error('skipped clip position must be an integer from 0 to 10000');
    }
    const numericPosition = position as number;
    if (numericPosition < this.nextNormalizePosition) return;
    this.pending.delete(numericPosition);
    this.skipped.add(numericPosition);
    void this.normalizeAvailable();
  }

  status(): PlayoutStatus {
    const audienceSeconds = Math.max(0, this.outputSeconds - this.audienceDelaySeconds);
    const current = this.boundaries.find((clip) => clip.endSeconds > audienceSeconds + 0.05);
    let playedThroughPosition = -1;
    for (const clip of this.boundaries) {
      if (clip.endSeconds <= audienceSeconds + 0.05) playedThroughPosition = clip.position;
    }
    return {
      sessionId: this.sessionId,
      hlsUrl: this.hlsUrl,
      state: this.state,
      normalizedClips: this.normalized.size,
      pendingClips: this.pending.size + Number(this.normalizeRunning),
      currentPosition: current?.position ?? null,
      playedThroughPosition,
      outputSeconds: Math.round(this.outputSeconds * 100) / 100,
      audienceSeconds: Math.round(audienceSeconds * 100) / 100,
      holdSeconds: this.holdSeconds,
      leadInSeconds: this.leadInSeconds,
      error: this.error,
      mediaDir: this.keepMedia ? this.tempRoot : null,
      finalMp4: this.finalMp4,
    };
  }

  /** Output-timeline placement of a published clip, or null until it has been fed. */
  clipBoundary(position: number): PlayoutClipBoundary | null {
    const boundary = this.boundaries.find((clip) => clip.position === position);
    if (!boundary) return null;
    return {
      position: boundary.position,
      storyBlockId: boundary.storyBlockId,
      startSeconds: boundary.startSeconds,
      endSeconds: boundary.endSeconds,
      holdSecondsBefore: boundary.holdSecondsBefore,
      leadInSecondsBefore: boundary.leadInSecondsBefore,
    };
  }

  private async normalizeAvailable(): Promise<void> {
    if (this.normalizeRunning || this.stopped) return;
    this.normalizeRunning = true;
    try {
      while (!this.stopped) {
        if (this.skipped.delete(this.nextNormalizePosition)) {
          this.nextNormalizePosition += 1;
          continue;
        }
        const input = this.pending.get(this.nextNormalizePosition);
        if (!input) break;
        this.pending.delete(input.position);
        const filePath = join(this.tempRoot, `${String(input.position).padStart(6, '0')}.ts`);
        const holdFilePath = join(this.tempRoot, `${String(input.position).padStart(6, '0')}.hold.ts`);
        const sourcePath = join(this.tempRoot, `${String(input.position).padStart(6, '0')}.source.mp4`);
        try {
          await downloadClip(input.videoUrl, sourcePath, this.fetchImpl, this.downloadTimeoutMs);
          await runProcess(
            this.ffmpegPath,
            normalizeClipArgs({ ...input, videoUrl: sourcePath }, filePath, 0),
            this.spawnImpl,
          );
          await runProcess(this.ffmpegPath, holdFrameArgs(filePath, holdFilePath), this.spawnImpl);
        } finally {
          await rm(sourcePath, { force: true });
        }
        const normalized = {
          ...input,
          filePath,
          holdFilePath,
        };
        this.normalized.set(input.position, normalized);
        this.nextNormalizePosition += 1;
        this.maybeStartPublisher();
        this.feedWake?.();
      }
    } catch (cause) {
      this.fail(cause);
    } finally {
      this.normalizeRunning = false;
    }
  }

  private maybeStartPublisher(): void {
    if (this.publisher || this.publisherRestartTimer || this.stopped) return;
    if (this.normalized.size >= this.startupBufferClips) {
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = null;
      this.startPublisher();
      return;
    }
    if (!this.startupTimer && this.normalized.size > 0) {
      this.startupTimer = setTimeout(() => this.startPublisher(), this.startupWaitMs);
    }
  }

  private startPublisher(): void {
    if (this.publisher || this.stopped || this.normalized.size === 0) return;
    this.publisherRestartTimer = null;
    this.state = 'starting';
    this.error = null;
    this.publisherTimelineOffsetSeconds = this.outputSeconds;
    const publisher = this.spawnImpl(this.ffmpegPath, publisherArgs(this.rtspUrl), {
      stdio: ['pipe', 'ignore', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams;
    this.publisher = publisher;
    let progressBuffer = '';
    publisher.stderr.on('data', (chunk: Buffer) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const match = line.match(/^out_time_us=(\d+)$/);
        if (!match) continue;
        this.outputSeconds = Math.max(
          this.outputSeconds,
          this.publisherTimelineOffsetSeconds + Number(match[1]) / 1_000_000,
        );
        this.publisherRestartAttempts = 0;
        if (this.outputSeconds > 0) this.state = 'streaming';
      }
    });
    publisher.once('error', (cause) => this.recoverPublisher(cause, publisher));
    publisher.once('exit', (code, signal) => {
      this.recoverPublisher(
        new Error(`FFmpeg publisher exited (${signal ?? code ?? 'unknown'})`),
        publisher,
      );
    });
    void this.feedPublisher(publisher);
  }

  private async feedPublisher(publisher: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.feedRunning || this.publisher !== publisher) return;
    this.feedRunning = true;
    try {
      while (!this.stopped && this.publisher === publisher) {
        const clip = this.normalized.get(this.nextPublishPosition);
        if (!clip) {
          const globalOutputSeconds = this.outputSeconds;
          const runwaySeconds = this.fedSeconds - globalOutputSeconds;
          if (this.activeHoldFilePath && runwaySeconds <= this.holdRunwaySeconds) {
            await this.appendAtTimelineOffset(
              this.activeHoldFilePath,
              join(this.tempRoot, 'active-hold.feed.ts'),
              this.fedSeconds,
              publisher.stdin,
              HOLD_CLIP_SECONDS,
            );
            this.fedSeconds += HOLD_CLIP_SECONDS;
            this.holdSeconds += HOLD_CLIP_SECONDS;
            this.holdSecondsSinceClip += HOLD_CLIP_SECONDS;
            continue;
          }
          await this.waitForFeed();
          continue;
        }
        // A commanded pause holds the previous clip's last frame for its whole duration before
        // this clip starts. Whole seconds only: hold frames are one-second units. Nothing to hold
        // ahead of the very first clip, so a lead-in there is dropped rather than shown as black.
        let leadInSecondsBefore = 0;
        const leadIn = Math.round(clip.leadInSeconds ?? 0);
        if (leadIn > 0 && this.activeHoldFilePath) {
          for (let held = 0; held < leadIn && !this.stopped && this.publisher === publisher; held += HOLD_CLIP_SECONDS) {
            await this.appendAtTimelineOffset(
              this.activeHoldFilePath,
              join(this.tempRoot, 'active-hold.feed.ts'),
              this.fedSeconds,
              publisher.stdin,
            );
            this.fedSeconds += HOLD_CLIP_SECONDS;
            this.leadInSeconds += HOLD_CLIP_SECONDS;
            leadInSecondsBefore += HOLD_CLIP_SECONDS;
          }
          if (this.stopped || this.publisher !== publisher) break;
        }
        const feedFilePath = join(this.tempRoot, `${String(clip.position).padStart(6, '0')}.feed.ts`);
        const startSeconds = this.fedSeconds;
        await this.appendAtTimelineOffset(clip.filePath, feedFilePath, this.fedSeconds, publisher.stdin);
        this.fedSeconds += clip.durationSeconds;
        this.boundaries.push({
          ...clip, startSeconds, endSeconds: this.fedSeconds, holdSecondsBefore: this.holdSecondsSinceClip, leadInSecondsBefore,
        });
        this.holdSecondsSinceClip = 0;
        const previousHoldFilePath = this.activeHoldFilePath;
        this.activeHoldFilePath = clip.holdFilePath;
        this.normalized.delete(clip.position);
        this.nextPublishPosition += 1;
        if (this.keepMedia) this.retainedFilePaths.push(clip.filePath);
        else await rm(clip.filePath, { force: true });
        if (previousHoldFilePath && previousHoldFilePath !== clip.holdFilePath) {
          await rm(previousHoldFilePath, { force: true });
        }
      }
    } catch (cause) {
      this.recoverPublisher(cause, publisher);
    } finally {
      this.feedRunning = false;
    }
  }

  private async waitForFeed(): Promise<void> {
    await new Promise<void>((resolve) => {
      const wake = () => {
        if (this.feedTimer) clearTimeout(this.feedTimer);
        this.feedTimer = null;
        if (this.feedWake === wake) this.feedWake = null;
        resolve();
      };
      this.feedWake = wake;
      this.feedTimer = setTimeout(wake, this.holdPollMs);
    });
  }

  private async appendAtTimelineOffset(
    inputPath: string,
    outputPath: string,
    offsetSeconds: number,
    destination: NodeJS.WritableStream,
    paceSeconds = 0,
  ): Promise<void> {
    try {
      await runProcess(
        this.ffmpegPath,
        rebaseTransportStreamArgs(inputPath, outputPath, offsetSeconds),
        this.spawnImpl,
      );
      await appendFileToStream(outputPath, destination, paceSeconds);
    } finally {
      await rm(outputPath, { force: true });
    }
  }

  private recoverPublisher(cause: unknown, publisher: ChildProcessWithoutNullStreams): void {
    if (this.stopped || this.publisher !== publisher) return;
    this.publisher = null;
    publisher.stdin.destroy();
    publisher.kill('SIGTERM');

    if (this.publisherRestartAttempts >= MAX_CONSECUTIVE_PUBLISHER_RESTARTS) {
      this.fail(cause);
      return;
    }
    this.publisherRestartAttempts += 1;
    this.state = this.normalized.size > 0 ? 'starting' : 'buffering';
    this.error = null;
    console.warn(
      `[h3 playout ${this.sessionId}] publisher interrupted; retrying (${this.publisherRestartAttempts}/${MAX_CONSECUTIVE_PUBLISHER_RESTARTS})`,
    );
    if (this.normalized.size === 0) return;
    this.publisherRestartTimer = setTimeout(
      () => this.startPublisher(),
      this.publisherRestartDelayMs * this.publisherRestartAttempts,
    );
  }

  private fail(cause: unknown): void {
    this.state = 'error';
    this.error = cause instanceof Error ? cause.message : 'playout failed';
    console.error(`[h3 playout ${this.sessionId}] ${this.error}`);
    this.publisher?.kill('SIGTERM');
    this.publisher = null;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.state = 'stopped';
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    if (this.publisherRestartTimer) clearTimeout(this.publisherRestartTimer);
    this.publisherRestartTimer = null;
    if (this.feedTimer) clearTimeout(this.feedTimer);
    this.feedTimer = null;
    this.feedWake?.();
    this.feedWake = null;
    this.publisher?.stdin.end();
    this.publisher?.kill('SIGTERM');
    this.publisher = null;
    if (!this.keepMedia) {
      await rm(this.tempRoot, { recursive: true, force: true });
      return;
    }
    await this.writeFinalMp4();
  }

  private async writeFinalMp4(): Promise<void> {
    if (this.retainedFilePaths.length === 0) return;
    const listPath = join(this.tempRoot, 'final.concat.txt');
    const outputPath = join(this.tempRoot, 'final.mp4');
    try {
      await writeFile(listPath, `${this.retainedFilePaths.map((path) => `file '${path}'`).join('\n')}\n`);
      await runProcess(this.ffmpegPath, concatToMp4Args(listPath, outputPath), this.spawnImpl);
      this.finalMp4 = outputPath;
    } catch (cause) {
      console.warn(`[h3 playout ${this.sessionId}] could not write final.mp4: ${cause instanceof Error ? cause.message : 'unknown failure'}`);
    } finally {
      await rm(listPath, { force: true });
    }
  }
}

export class PlayoutManager {
  private readonly sessions = new Map<string, PlayoutSession>();
  private readonly options: PlayoutOptions;

  constructor(options: PlayoutOptions = {}) {
    this.options = options;
  }

  async start(options: Pick<PlayoutOptions, 'startupBufferClips' | 'startupWaitMs'> = {}): Promise<PlayoutSession> {
    const session = new PlayoutSession({ ...this.options, ...options });
    await session.initialize();
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): PlayoutSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async stop(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    await session.stop();
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.stop()));
    this.sessions.clear();
  }
}
