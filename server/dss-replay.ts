import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseDssFrame, type DssFrame } from './external-renderer.js';
import { normalizeClipArgs } from './playout.js';
import { parseRendererConfig, type RendererConfig } from './render-mode.js';
import { MinimaxSceneAssetCache } from './scene-context.js';
import { ShotGenerator, type GeneratedShot, type ShotDependency } from './shot-generation.js';
import { DssShotPlanner, type PlannedGroup, type PlannedShot, type ShotPlannerSettings } from './shot-planner.js';
import { ShotScheduler } from './shot-scheduler.js';

/**
 * PIC-1410: Offline replay of recorded DSS through the live compiler and continuity
 * policy. Planning is free; rendering submits the same paid jobs the bridge would,
 * minus kernel transport, playback pacing, and acknowledgements.
 */
type JsonObject = Record<string, unknown>;

export interface ReplayOptions {
  rendererConfig?: Partial<RendererConfig>;
  resolution?: '480P' | '768P';
  clipDurationSeconds?: number;
  shotPlanner?: ShotPlannerSettings;
  initialImageUrl?: string;
  episodeId?: number;
  /** Inclusive payload sequence range to plan or render; earlier payloads still replay staging. */
  from?: number;
  to?: number;
  signal?: AbortSignal;
  /** Present only when rendering: paid provider calls, clip download, and MP4 assembly. */
  render?: { apiKey: string; outDir: string; media?: ReplayMedia };
}

export interface ReplayShot {
  /** 1-based position among selected shots; the summary refers to sources by it. */
  index: number;
  sequence: number;
  groupId: string;
  shotId: string;
  storyBlockId: string;
  speaker?: string;
  dialogue?: string;
  durationSeconds: number;
  hasMovement: boolean;
  anchorKey: string;
  sceneKey: string;
  dependency: ShotDependency;
  imageReferences: ReadonlyArray<{ name: string; label: string }>;
  audioReferences: ReadonlyArray<{ name: string; label: string; purpose: string }>;
  prompt: string;
  generated?: GeneratedShot & { clipPath?: string };
  error?: string;
}

export interface ReplayControl { sequence: number; groupId: string; durationSeconds: number }

export interface ReplayResult {
  rendererConfig: RendererConfig;
  resolution: '480P' | '768P';
  clipDurationSeconds: number;
  payloads: { total: number; replayedForStaging: number; selected: number; skipped: number };
  shots: ReplayShot[];
  controls: ReplayControl[];
  warnings: string[];
  /** Wall-clock and provider timings that decide whether the mode can keep up with playback. */
  timing?: { wallSeconds: number; videoSeconds: number; providerSeconds: number; realtimeRatio: number };
  output?: { clipsDir: string; moviePath: string | null; failures: number };
}

export interface ReplayMedia {
  download(url: string, path: string, signal?: AbortSignal): Promise<void>;
  normalize(inputPath: string, outputPath: string, durationSeconds: number, offsetSeconds: number, signal?: AbortSignal): Promise<void>;
  concat(inputs: string[], outputPath: string, signal?: AbortSignal): Promise<void>;
}

/** Accepts a JSON array, one object, or JSONL; unwraps `{received_at, event}` capture rows. */
export function loadDssRecording(text: string): JsonObject[] {
  let values: unknown;
  try { values = JSON.parse(text); } catch {
    values = text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at nonempty line ${index + 1}`); }
    });
  }
  const rows = (Array.isArray(values) ? values : [values]).map(value => {
    const row = value as JsonObject;
    return (row && typeof row === 'object' && row.event && typeof row.event === 'object' ? row.event : row) as JsonObject;
  });
  if (rows.length === 0) throw new Error('The recording contains no DSS payloads');
  const byKey = new Map<string, JsonObject>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !row.script || typeof row.script !== 'object') throw new Error('Each DSS payload needs a script object');
    const script = row.script as JsonObject;
    const episode = script.episode_id ?? row.episode_id;
    const sequence = script.sequence ?? row.sequence;
    if (!Number.isInteger(sequence)) throw new Error('Each DSS payload needs an integer sequence');
    const key = `${episode}:${sequence}`;
    const previous = byKey.get(key);
    const canonical = JSON.stringify(script);
    if (previous && JSON.stringify(previous.script) !== canonical) throw new Error(`Conflicting duplicate DSS sequence ${sequence}`);
    if (!previous) byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => {
    const episodeA = Number((a.script as JsonObject).episode_id ?? a.episode_id ?? 0);
    const episodeB = Number((b.script as JsonObject).episode_id ?? b.episode_id ?? 0);
    if (episodeA !== episodeB) return episodeA - episodeB;
    return Number((a.script as JsonObject).sequence ?? a.sequence) - Number((b.script as JsonObject).sequence ?? b.sequence);
  });
}

function run(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { signal, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr?.toString().trim() || error.message}`));
      else resolve();
    });
  });
}

export const ffmpegMedia: ReplayMedia = {
  async download(url, path, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Clip download failed with HTTP ${response.status}`);
    await writeFile(path, new Uint8Array(await response.arrayBuffer()));
  },
  normalize(inputPath, outputPath, durationSeconds, offsetSeconds, signal) {
    return run('ffmpeg', normalizeClipArgs({ position: 0, storyBlockId: 'replay', videoUrl: inputPath, durationSeconds }, outputPath, offsetSeconds), signal);
  },
  concat(inputs, outputPath, signal) {
    return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', `concat:${inputs.join('|')}`, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', outputPath], signal);
  },
};

function selected(sequence: number, options: ReplayOptions): boolean {
  return (options.from === undefined || sequence >= options.from) && (options.to === undefined || sequence <= options.to);
}

export async function replayDss(payloads: readonly JsonObject[], options: ReplayOptions = {}): Promise<ReplayResult> {
  const rendererConfig = parseRendererConfig(options.rendererConfig);
  const resolution = options.resolution ?? '480P';
  const clipDurationSeconds = options.clipDurationSeconds ?? 5;
  const initialImageUrl = options.initialImageUrl ?? options.shotPlanner?.initialImageUrl;
  if (rendererConfig.model === 'fal-turbo-i2v' && !initialImageUrl) throw new Error('fal-turbo-i2v requires an initialImageUrl');
  if (rendererConfig.model === 'auto') throw new Error('Replay compiles explicit fal modes; choose fal-max-ref2v or fal-turbo-i2v');
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
  const planner = new DssShotPlanner({
    ...options.shotPlanner, initialImageUrl,
    referenceMode: rendererConfig.model === 'fal-turbo-i2v' ? 'initial-frame' : 'reference',
    defaultDurationSeconds: clipDurationSeconds,
  });
  const scheduler = new ShotScheduler<GeneratedShot>(rendererConfig.concurrency, rendererConfig.maxBufferedSeconds, controller.signal);
  const generator = new ShotGenerator({
    renderMode: rendererConfig.model, continuity: rendererConfig.continuity, resolution, initialImageUrl,
    apiKey: options.render?.apiKey ?? 'plan-only', scheduler, signal: controller.signal,
  });
  const sceneAssets = new MinimaxSceneAssetCache();
  const result: ReplayResult = {
    rendererConfig, resolution, clipDurationSeconds,
    payloads: { total: payloads.length, replayedForStaging: 0, selected: 0, skipped: 0 },
    shots: [], controls: [], warnings: [],
  };
  const jobs: Array<{ shot: ReplayShot; job: ReturnType<ShotGenerator['schedule']>['job'] }> = [];
  const startedAt = Date.now();

  for (const raw of payloads) {
    let frame: DssFrame;
    try { frame = parseDssFrame(raw); } catch (error) {
      result.warnings.push(`Payload skipped: ${error instanceof Error ? error.message : String(error)}`);
      result.payloads.skipped += 1;
      continue;
    }
    if (options.episodeId !== undefined && frame.episodeId !== options.episodeId) { result.payloads.skipped += 1; continue; }
    const inRange = selected(frame.sequence, options);
    if (inRange) result.payloads.selected += 1; else result.payloads.replayedForStaging += 1;
    // Rendering downloads certified images like the bridge; planning keeps the recorded URLs.
    if (frame.sceneContext && options.render) frame.sceneContext = await sceneAssets.resolve(frame.sceneContext, controller.signal);
    planner.applySceneContext(frame.sceneContext ?? null, frame.sceneIndex);
    for (const group of frame.groups) {
      if (group.commands.length === 0) continue;
      let plan: PlannedGroup;
      try { plan = planner.planGroup(group.commands, group.id, frame.storyBlockId); } catch (error) {
        // The bridge would fail the run here; replay reports it and keeps compiling later payloads.
        result.warnings.push(`Sequence ${frame.sequence} group ${group.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!inRange) continue;
      if (plan.shots.length === 0) {
        result.controls.push({ sequence: frame.sequence, groupId: group.id, durationSeconds: plan.delaySeconds });
        continue;
      }
      for (const shot of plan.shots) {
        try { generator.validate(shot); } catch (error) {
          if (options.render) throw error;
          result.warnings.push(`Sequence ${frame.sequence} shot ${shot.id}${shot.speaker ? ` (${shot.speaker})` : ''}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const shot of plan.shots) {
        const entry = describeShot(frame, shot, result.shots.length + 1);
        if (options.render) {
          const { dependency, job } = generator.schedule(shot);
          entry.dependency = dependency;
          jobs.push({ shot: entry, job });
        } else {
          entry.dependency = generator.plan(shot);
        }
        result.shots.push(entry);
      }
    }
  }

  if (!options.render) return result;
  const { outDir, media = ffmpegMedia } = options.render;
  const clipsDir = join(outDir, 'clips');
  await mkdir(clipsDir, { recursive: true });
  let failures = 0;
  let providerSeconds = 0;
  const normalized: string[] = [];
  let offset = 0;
  for (const [index, { shot, job }] of jobs.entries()) {
    try {
      const generated = await job.result;
      job.release();
      providerSeconds += generated.timings?.totalSeconds ?? 0;
      const clipPath = join(clipsDir, `${String(index + 1).padStart(3, '0')}-seq${shot.sequence}.mp4`);
      await media.download(generated.videoUrl, clipPath, controller.signal);
      const tsPath = clipPath.replace(/\.mp4$/, '.ts');
      await media.normalize(clipPath, tsPath, shot.durationSeconds, offset, controller.signal);
      offset += shot.durationSeconds;
      normalized.push(tsPath);
      shot.generated = { ...generated, continuityFrame: generated.continuityFrame ? '[frame]' : undefined, clipPath };
    } catch (error) {
      failures += 1;
      shot.error = error instanceof Error ? error.message : String(error);
      job.release();
    }
  }
  await scheduler.drain();
  let moviePath: string | null = null;
  if (failures === 0 && normalized.length > 0) {
    moviePath = join(outDir, 'story.mp4');
    await media.concat(normalized, moviePath, controller.signal);
  }
  const wallSeconds = (Date.now() - startedAt) / 1000;
  const videoSeconds = result.shots.filter(shot => shot.generated).reduce((sum, shot) => sum + shot.durationSeconds, 0);
  result.timing = { wallSeconds, videoSeconds, providerSeconds, realtimeRatio: videoSeconds > 0 ? wallSeconds / videoSeconds : 0 };
  result.output = { clipsDir, moviePath, failures };
  return result;
}

function describeShot(frame: DssFrame, shot: PlannedShot, index: number): ReplayShot {
  return {
    index, sequence: frame.sequence, groupId: shot.groupId, shotId: shot.id, storyBlockId: shot.storyBlockId,
    speaker: shot.speaker, dialogue: shot.dialogue, durationSeconds: shot.durationSeconds, hasMovement: shot.hasMovement,
    anchorKey: shot.anchorKey, sceneKey: shot.sceneKey, dependency: { kind: 'independent' },
    imageReferences: shot.imageReferences.map(({ name, label }) => ({ name, label })),
    audioReferences: shot.audioReferences.map(({ name, label, purpose }) => ({ name, label, purpose })),
    prompt: shot.prompt,
  };
}

export function describeDependency(dependency: ShotDependency, shots: readonly ReplayShot[] = []): string {
  const source = (shotId: string) => { const found = shots.find(shot => shot.shotId === shotId); return found ? `#${found.index}` : shotId; };
  switch (dependency.kind) {
    case 'independent': return 'independent';
    case 'anchor-establish': return 'anchor: establish';
    case 'anchor-reuse': return `anchor: reuse ${source(dependency.sourceShotId)}`;
    case 'chain-start': return 'chain: start';
    case 'chain': return `chain: from ${source(dependency.sourceShotId)}`;
  }
}

export function formatReplaySummary(result: ReplayResult): string {
  const lines = [
    `model=${result.rendererConfig.model} continuity=${result.rendererConfig.continuity} concurrency=${result.rendererConfig.concurrency} budget=${result.rendererConfig.maxBufferedSeconds}s resolution=${result.resolution}`,
    `payloads: ${result.payloads.selected} selected, ${result.payloads.replayedForStaging} replayed for staging, ${result.payloads.skipped} skipped`,
    `shots: ${result.shots.length} (${result.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)}s video), controls: ${result.controls.length}`,
  ];
  for (const shot of result.shots) {
    const who = shot.speaker ? `${shot.speaker}: ` : '';
    const status = shot.error ? ` FAILED ${shot.error}` : shot.generated?.timings ? ` ${shot.generated.timings.totalSeconds.toFixed(1)}s` : '';
    lines.push(`  #${shot.index} seq ${shot.sequence} ${shot.durationSeconds}s [${describeDependency(shot.dependency, result.shots)}] ${who}${(shot.dialogue ?? '').slice(0, 60)}${status}`);
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (result.timing) {
    lines.push(`timing: ${result.timing.wallSeconds.toFixed(1)}s wall for ${result.timing.videoSeconds}s video (ratio ${result.timing.realtimeRatio.toFixed(2)}, provider ${result.timing.providerSeconds.toFixed(1)}s summed)`);
  }
  if (result.output) lines.push(result.output.moviePath ? `movie: ${result.output.moviePath}` : `no movie: ${result.output.failures} shot(s) failed`);
  return lines.join('\n');
}
