import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ffmpegMedia, type ReplayMedia } from './dss-replay.js';
import { parseDssFrame } from './external-renderer.js';
import { generateVideo } from './fal.js';
import { defaultRequestTimeoutMs } from './provider-timeouts.js';
import { ShotScheduler } from './shot-scheduler.js';
import { DEFAULT_LORA_SCALE, LORA_V4_URL } from './whispmax/lora.js';
import { packWhispmaxClips, type WhispmaxClip, type WhispmaxSourcePayload } from './whispmax/pack.js';

/**
 * PIC-1832: offline replay for the WhispMax LoRA mode. One prompt is one clip and the clip's
 * own generated audio is the performance, so this path packs several talk beats into a clip
 * instead of the one-shot-per-line mapping the reference modes use. Group accounting stays
 * per beat: a clip carries every group it covers.
 */
type JsonObject = Record<string, unknown>;

export interface WhispmaxReplayOptions {
  resolution?: '480P' | '768P';
  baseSeed?: number;
  episodeId?: number;
  from?: number;
  to?: number;
  concurrency?: number;
  maxBufferedSeconds?: number;
  /** Paid-spend cap: the run aborts before submitting when the plan exceeds it. */
  maxClips?: number;
  /** Probe whether the LoRA endpoint accepts the beats' dialogue audio as reference audio. */
  referenceAudio?: boolean;
  loraUrl?: string;
  loraScale?: number;
  signal?: AbortSignal;
  render?: { apiKey: string; outDir: string; media?: ReplayMedia; queueBaseUrl?: string };
}

export interface WhispmaxGeneratedClip {
  requestId: string;
  videoUrl: string;
  clipPath?: string;
  measuredDurationSeconds?: number;
  hasAudio?: boolean;
  timings: { submitSeconds: number; queueSeconds: number; totalSeconds: number; polls: number; maxQueuePosition?: number | null };
}

export interface WhispmaxReplayClip extends WhispmaxClip {
  /** Every DSS group this one clip speaks for; progress must attribute the clip to all of them. */
  groupIds: string[];
  referenceAudioUrls?: string[];
  generated?: WhispmaxGeneratedClip;
  error?: string;
}

export interface WhispmaxReplayResult {
  model: 'whispmax-t2v';
  resolution: '480P' | '768P';
  loraUrl: string;
  loraScale: number;
  baseSeed: number;
  payloads: { total: number; selected: number; skipped: number };
  clips: WhispmaxReplayClip[];
  holds: { sequence: number; groupId: string; durationSeconds: number }[];
  warnings: string[];
  totals: { clips: number; videoSeconds: number; durationHistogram: Record<string, number>; dialogueSeconds: number };
  /** The endpoint's verdict on `reference_audio_urls`, which the api guide does not document. */
  referenceAudio?: { requested: boolean; clips: number; accepted: boolean; error?: string };
  timing?: { wallSeconds: number; videoSeconds: number; providerSeconds: number; realtimeRatio: number };
  output?: { clipsDir: string; promptsDir: string; moviePath: string | null; failures: number };
}

export function planWhispmax(payloads: readonly JsonObject[], options: WhispmaxReplayOptions = {}): WhispmaxReplayResult {
  const resolution = options.resolution ?? '768P';
  const baseSeed = options.baseSeed ?? 4242;
  const sources: WhispmaxSourcePayload[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  for (const raw of payloads) {
    let frame;
    try { frame = parseDssFrame(raw); } catch (error) {
      warnings.push(`Payload skipped: ${error instanceof Error ? error.message : String(error)}`);
      skipped += 1;
      continue;
    }
    if (options.episodeId !== undefined && frame.episodeId !== options.episodeId) { skipped += 1; continue; }
    sources.push({
      sequence: frame.sequence,
      storyBlockId: frame.storyBlockId,
      groups: frame.groups.map(group => ({ id: group.id, commands: group.commands as readonly JsonObject[] })),
    });
  }
  const plan = packWhispmaxClips(sources, {
    baseSeed,
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
  });
  const clips: WhispmaxReplayClip[] = plan.clips.map(clip => ({
    ...clip,
    groupIds: [...new Set(clip.beats.map(beat => beat.groupId))],
    ...(options.referenceAudio
      ? { referenceAudioUrls: clip.beats.map(beat => beat.audioUrl).filter((url): url is string => Boolean(url)) }
      : {}),
  }));
  const durationHistogram: Record<string, number> = {};
  for (const clip of clips) {
    const key = `${clip.durationSeconds}s`;
    durationHistogram[key] = (durationHistogram[key] ?? 0) + 1;
  }
  return {
    model: 'whispmax-t2v', resolution,
    loraUrl: options.loraUrl ?? LORA_V4_URL,
    loraScale: options.loraScale ?? DEFAULT_LORA_SCALE,
    baseSeed,
    payloads: { total: payloads.length, selected: sources.length, skipped },
    clips,
    holds: plan.holds,
    warnings: [...warnings, ...plan.warnings],
    totals: {
      clips: clips.length,
      videoSeconds: clips.reduce((sum, clip) => sum + clip.durationSeconds, 0),
      durationHistogram,
      dialogueSeconds: Math.round(clips.reduce((sum, clip) => sum + clip.beats.reduce((inner, beat) => inner + beat.audioDuration, 0), 0) * 10) / 10,
    },
  };
}

export async function replayWhispmaxDss(
  payloads: readonly JsonObject[],
  options: WhispmaxReplayOptions = {},
): Promise<WhispmaxReplayResult> {
  const result = planWhispmax(payloads, options);
  const promptsDir = options.render ? join(options.render.outDir, 'prompts') : '';
  if (!options.render) return result;
  if (options.maxClips !== undefined && result.clips.length > options.maxClips) {
    throw new Error(`The plan has ${result.clips.length} clips, above the --max-clips cap of ${options.maxClips}; narrow --from/--to`);
  }
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
  const { outDir, media = ffmpegMedia } = options.render;
  const clipsDir = join(outDir, 'clips');
  await mkdir(clipsDir, { recursive: true });
  await mkdir(promptsDir, { recursive: true });
  const scheduler = new ShotScheduler<WhispmaxGeneratedClip>(
    options.concurrency ?? 4, options.maxBufferedSeconds ?? 45, controller.signal,
  );
  const startedAt = Date.now();
  const jobs = result.clips.map(clip => ({
    clip,
    job: scheduler.add(clip.durationSeconds, async () => {
      const generated = await generateVideo({
        prompt: clip.prompt,
        duration: clip.durationSeconds,
        resolution: result.resolution,
        aspectRatio: '16:9',
        renderMode: 'whispmax-t2v',
        loras: [{ path: result.loraUrl, scale: result.loraScale }],
        seed: clip.seed,
        ...(clip.referenceAudioUrls?.length ? { referenceAudioUrls: [...clip.referenceAudioUrls] } : {}),
      }, {
        apiKey: options.render!.apiKey,
        queueBaseUrl: options.render!.queueBaseUrl ?? process.env.FAL_QUEUE_BASE_URL,
        timeoutMs: defaultRequestTimeoutMs(),
        signal: controller.signal,
      });
      return { requestId: generated.requestId, videoUrl: generated.videoUrl, timings: generated.timings };
    }),
  }));

  let failures = 0;
  let providerSeconds = 0;
  const normalized: string[] = [];
  let offset = 0;
  for (const [index, { clip, job }] of jobs.entries()) {
    try {
      const generated = await job.result;
      job.release();
      providerSeconds += generated.timings.totalSeconds;
      const clipPath = join(clipsDir, `${String(index + 1).padStart(3, '0')}-seq${clip.beats[0]?.sequence ?? 0}.mp4`);
      await media.download(generated.videoUrl, clipPath, controller.signal);
      const tsPath = clipPath.replace(/\.mp4$/, '.ts');
      await media.normalize(clipPath, tsPath, clip.durationSeconds, offset, controller.signal);
      offset += clip.durationSeconds;
      normalized.push(tsPath);
      clip.generated = { ...generated, clipPath };
    } catch (error) {
      failures += 1;
      clip.error = error instanceof Error ? error.message : String(error);
      job.release();
    }
  }
  await scheduler.drain();
  if (options.referenceAudio) {
    const probed = result.clips.filter(clip => clip.referenceAudioUrls?.length);
    result.referenceAudio = {
      requested: true,
      clips: probed.length,
      accepted: probed.some(clip => clip.generated),
      ...(probed.find(clip => clip.error) ? { error: probed.find(clip => clip.error)!.error } : {}),
    };
  }
  let moviePath: string | null = null;
  if (normalized.length > 0) {
    moviePath = join(outDir, 'story.mp4');
    await media.concat(normalized, moviePath, controller.signal);
  }
  const videoSeconds = result.clips.filter(clip => clip.generated).reduce((sum, clip) => sum + clip.durationSeconds, 0);
  const wallSeconds = (Date.now() - startedAt) / 1000;
  result.timing = { wallSeconds, videoSeconds, providerSeconds, realtimeRatio: videoSeconds > 0 ? wallSeconds / videoSeconds : 0 };
  result.output = { clipsDir, promptsDir, moviePath, failures };
  return result;
}

/** Every compiled prompt on disk, so a human can eyeball what the LoRA was actually asked for. */
export async function writeWhispmaxPrompts(result: WhispmaxReplayResult, outDir: string): Promise<string> {
  const promptsDir = join(outDir, 'prompts');
  await mkdir(promptsDir, { recursive: true, mode: 0o700 });
  for (const [index, clip] of result.clips.entries()) {
    await writeFile(join(promptsDir, `${String(index + 1).padStart(3, '0')}.txt`), `${clip.prompt}\n`, { mode: 0o600 });
  }
  return promptsDir;
}

export function formatWhispmaxSummary(result: WhispmaxReplayResult): string {
  const lines = [
    `model=whispmax-t2v resolution=${result.resolution} lora=${result.loraUrl.split('/').at(-1)} scale=${result.loraScale} base-seed=${result.baseSeed}`,
    `payloads: ${result.payloads.selected} selected, ${result.payloads.skipped} skipped`,
    `clips: ${result.totals.clips} (${result.totals.videoSeconds}s video for ${result.totals.dialogueSeconds}s dialogue), holds: ${result.holds.length}`,
    `duration histogram: ${Object.entries(result.totals.durationHistogram).sort(([a], [b]) => Number.parseInt(a, 10) - Number.parseInt(b, 10)).map(([key, count]) => `${key}×${count}`).join(' ') || 'none'}`,
  ];
  for (const clip of result.clips) {
    const status = clip.error
      ? ` FAILED ${clip.error}`
      : clip.generated ? ` ${clip.generated.timings.totalSeconds.toFixed(1)}s q${clip.generated.timings.maxQueuePosition ?? '-'}` : '';
    const cast = clip.visibleCharacters.join(' + ');
    lines.push(`  #${clip.index + 1} ${clip.durationSeconds}s seed ${clip.seed} [${clip.set ?? 'no set'}${clip.zone ? ` / ${clip.zone}` : ''}] ${clip.beats.length} beat(s) ${cast}${status}`);
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (result.referenceAudio) {
    lines.push(`reference audio: ${result.referenceAudio.clips} clip(s) probed, accepted=${result.referenceAudio.accepted}${result.referenceAudio.error ? ` error=${result.referenceAudio.error}` : ''}`);
  }
  if (result.timing) {
    lines.push(`timing: ${result.timing.wallSeconds.toFixed(1)}s wall for ${result.timing.videoSeconds}s video (ratio ${result.timing.realtimeRatio.toFixed(2)}, provider ${result.timing.providerSeconds.toFixed(1)}s summed)`);
  }
  if (result.output) lines.push(result.output.moviePath ? `movie: ${result.output.moviePath}` : `no movie: ${result.output.failures} clip(s) failed`);
  return lines.join('\n');
}
