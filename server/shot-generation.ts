import { generateVideo } from './fal.js';
import { generateStillFrame, orderStillReferences } from './still-frame.js';
import type { StillClipSession } from './still-clip.js';
import { type ReferenceUploader, uploadDataUrl } from './fal-storage.js';
import { defaultRequestTimeoutMs } from './provider-timeouts.js';

const DEFAULT_INDEPENDENT_STARTUP_SHOTS = (() => {
  const parsed = Number.parseInt(process.env.RENDERER_INDEPENDENT_STARTUP_SHOTS ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 2;
})();
import type { ContinuityStrategy, RenderMode } from './render-mode.js';
import type { PlannedShot } from './shot-planner.js';
import type { ScheduledShot, ShotScheduler } from './shot-scheduler.js';
import { extractVideoFrame } from './video-frame.js';

/**
 * PIC-1410: One continuity policy for every host of the compiler. The live bridge
 * and the offline replay harness both resolve anchors and chains here, so a rule
 * that changes for one cannot silently diverge for the other.
 */
export interface GeneratedShot {
  videoUrl: string;
  continuityFrame?: string;
  requestId?: string;
  submittedPrompt?: string;
  referenceImageCount?: number;
  timings?: { submitSeconds: number; queueSeconds: number; totalSeconds: number; polls: number; maxQueuePosition?: number | null };
  /**
   * PIC-1974: single-frame only. The clip is synthesized on this machine, so a consumer that can
   * read the filesystem (the offline replay harness) uses the file directly instead of fetching
   * the loopback URL, and the run log can separate image time from mux time.
   */
  localFilePath?: string;
  stillImageUrl?: string;
  stillModelId?: string;
  /** Which references actually survived the edit endpoint's four-image cap, in order. */
  stillReferenceNames?: string[];
  /** When the generated image came back, i.e. before the ffmpeg mux. */
  imageReadyAt?: string;
}

export type ShotDependency =
  | { kind: 'independent' }
  | { kind: 'anchor-establish'; anchorKey: string }
  | { kind: 'anchor-reuse'; anchorKey: string; sourceShotId: string }
  | { kind: 'chain-start'; sceneKey: string }
  | { kind: 'chain'; sceneKey: string; sourceShotId: string };

export interface ShotGeneratorOptions {
  renderMode: RenderMode;
  continuity: ContinuityStrategy;
  resolution: '480P' | '768P';
  initialImageUrl?: string;
  apiKey: string;
  scheduler: ShotScheduler<GeneratedShot>;
  signal: AbortSignal;
  /** Uploads an extracted continuity frame once so later shots reference a URL, not inline bytes. */
  frameUploader?: ReferenceUploader;
  /**
   * How many shots at the start of a run generate without waiting on an anchor. A story's first
   * line must not trail its opening shot by a whole generation, so these establish independently
   * and later shots reuse whichever anchor landed first.
   */
  independentStartupShots?: number;
  /** Runs before and after each provider call; throw to fence the shot (assignment change, verdict health). */
  guard?: () => void;
  queueBaseUrl?: string;
  timeoutMs?: number;
  /** PIC-1974: required in `single-frame`; muxes each generated still with the line's audio. */
  stillClipSession?: StillClipSession;
  /** Uploads references fal cannot fetch, shared with `stillUploadCache` across the whole run. */
  stillReferenceUploader?: ReferenceUploader;
  stillUploadCache?: Map<string, Promise<string>>;
}

interface Source { shotId: string; job: ScheduledShot<GeneratedShot> | null }

export class ShotGenerator {
  private readonly anchors = new Map<string, Source>();
  private readonly sceneTails = new Map<string, Source>();

  private shotsSeen = 0;

  constructor(private readonly options: ShotGeneratorOptions) {}

  private get startupIndependent(): boolean {
    return this.shotsSeen < (this.options.independentStartupShots ?? DEFAULT_INDEPENDENT_STARTUP_SHOTS);
  }

  /** Reference-slot rules that must hold before any paid submission for the shot's payload. */
  validate(shot: PlannedShot): void {
    if (shot.preparedCoverage && this.options.renderMode !== 'fal-max-ref2v') throw new Error('Prepared coverage requires the fal-max-ref2v adapter');
    if (this.options.renderMode !== 'fal-max-ref2v') return;
    if (shot.referenceImageUrls.length === 0) throw new Error('fal-max-ref2v requires configured image references for every shot');
    const anchors = !shot.preparedCoverage && this.options.continuity === 'camera-anchors';
    const referenceLimit = anchors ? 11 : 12;
    if (shot.referenceImageUrls.length + shot.referenceAudioUrls.length > referenceLimit) {
      throw new Error(anchors
        ? 'fal-max-ref2v allows at most 11 configured image/audio references, reserving one slot for the camera anchor'
        : 'fal-max-ref2v allows at most 12 image/audio references');
    }
  }

  /** The dependency `schedule` would create for this shot, given the shots registered so far. */
  describe(shot: PlannedShot): ShotDependency {
    if (shot.preparedCoverage) return { kind: 'independent' };
    const { continuity } = this.options;
    if (continuity === 'last-frame-chain') {
      const tail = this.sceneTails.get(shot.sceneKey);
      return tail ? { kind: 'chain', sceneKey: shot.sceneKey, sourceShotId: tail.shotId } : { kind: 'chain-start', sceneKey: shot.sceneKey };
    }
    if (continuity === 'camera-anchors') {
      const anchor = this.startupIndependent ? undefined : this.anchors.get(shot.anchorKey);
      return anchor
        ? { kind: 'anchor-reuse', anchorKey: shot.anchorKey, sourceShotId: anchor.shotId }
        : { kind: 'anchor-establish', anchorKey: shot.anchorKey };
    }
    return { kind: 'independent' };
  }

  /** Registers the shot as a continuity source without generating; for offline planning only. */
  plan(shot: PlannedShot): ShotDependency {
    const dependency = this.describe(shot);
    this.register(shot, dependency, null);
    return dependency;
  }

  /** `shotGuard` fences this shot alone, e.g. against the assignment its payload arrived under. */
  schedule(shot: PlannedShot, shotGuard?: () => void): { dependency: ShotDependency; job: ScheduledShot<GeneratedShot> } {
    const { renderMode: mode, continuity, scheduler, signal } = this.options;
    this.validate(shot);
    const guard = () => { this.options.guard?.(); shotGuard?.(); };
    const dependency = this.describe(shot);
    const source = dependency.kind === 'anchor-reuse' ? this.anchors.get(shot.anchorKey)
      : dependency.kind === 'chain' ? this.sceneTails.get(shot.sceneKey) : undefined;
    if (source && !source.job) throw new Error('ShotGenerator cannot mix plan() and schedule()');
    const job = scheduler.add(shot.durationSeconds, async () => {
      guard();
      const previous = source ? await source.job!.result : undefined;
      guard();
      const continuityFrame = previous?.continuityFrame;
      if (source && !continuityFrame) throw new Error('Required shot continuity frame is unavailable');
      const images = [...shot.referenceImageUrls];
      let prompt = shot.prompt;
      if (continuity === 'camera-anchors' && continuityFrame) {
        images.push(continuityFrame);
        prompt += ` Preserve the camera composition and character appearance of Image ${images.length}, the established frame for this camera setup.`;
      }
      // PIC-1974: the stills mode replaces the provider clip with a generated frame muxed against
      // the line's own dialogue audio. Placed at the provider call site so the continuity work
      // above (a no-op under continuity `none`) and the scheduling below are untouched.
      if (mode === 'single-frame') {
        const session = this.options.stillClipSession;
        if (!session) throw new Error('single-frame rendering requires a still clip session');
        // The set is the planner's last reference, so it must be prioritized explicitly or the
        // four-image cap drops the environment before it drops a spare face.
        const stillReferences = orderStillReferences(shot.imageReferences, shot.speaker);
        const still = await generateStillFrame({ prompt, referenceImageUrls: stillReferences.map(entry => entry.url) }, {
          apiKey: this.options.apiKey, queueBaseUrl: this.options.queueBaseUrl ?? process.env.FAL_QUEUE_BASE_URL,
          timeoutMs: this.options.timeoutMs ?? defaultRequestTimeoutMs(), signal,
          referenceUploader: this.options.stillReferenceUploader, uploadCache: this.options.stillUploadCache,
        });
        const imageReadyAt = new Date().toISOString();
        guard();
        const clip = await session.synthesize({
          shotId: shot.id, imageUrl: still.imageUrl,
          dialogueAudioUrl: shot.dialogueAudioUrl ?? null, holdSeconds: shot.durationSeconds, signal,
        });
        guard();
        return {
          videoUrl: clip.url, localFilePath: clip.filePath, requestId: still.requestId,
          submittedPrompt: prompt, referenceImageCount: stillReferences.length, timings: still.timings,
          stillImageUrl: still.imageUrl, stillModelId: still.modelId, imageReadyAt,
          stillReferenceNames: stillReferences.map(entry => entry.name),
        };
      }
      const generated = await generateVideo({
        prompt, duration: shot.durationSeconds, resolution: this.options.resolution, aspectRatio: '16:9',
        renderMode: mode,
        initialImageUrl: mode === 'fal-turbo-i2v' ? continuityFrame ?? this.options.initialImageUrl : undefined,
        referenceImageUrls: mode === 'fal-max-ref2v' ? images : undefined,
        referenceAudioUrls: mode === 'fal-max-ref2v' ? [...shot.referenceAudioUrls] : undefined,
      }, {
        apiKey: this.options.apiKey, queueBaseUrl: this.options.queueBaseUrl ?? process.env.FAL_QUEUE_BASE_URL,
        timeoutMs: this.options.timeoutMs ?? defaultRequestTimeoutMs(), signal,
      });
      guard();
      let nextFrame = shot.preparedCoverage || continuity === 'none' ? undefined : continuity === 'last-frame-chain' || !source
        ? await extractVideoFrame(generated.videoUrl, {
          position: continuity === 'last-frame-chain' || shot.hasMovement ? 'last' : 'first', signal,
        })
        : continuityFrame;
      guard();
      if (nextFrame !== undefined && nextFrame !== continuityFrame && this.options.frameUploader && nextFrame.startsWith('data:')) {
        nextFrame = await uploadDataUrl(nextFrame, `frame-${shot.id.replace(/[^A-Za-z0-9_-]/g, '_')}.jpg`, this.options.frameUploader, signal);
        guard();
      }
      return {
        videoUrl: generated.videoUrl, continuityFrame: nextFrame, requestId: generated.requestId,
        submittedPrompt: prompt, referenceImageCount: mode === 'fal-max-ref2v' ? images.length : undefined, timings: generated.timings,
      };
    }, source?.job!.result);
    this.register(shot, dependency, job);
    return { dependency, job };
  }

  private register(shot: PlannedShot, dependency: ShotDependency, job: ScheduledShot<GeneratedShot> | null): void {
    this.shotsSeen += 1;
    if (dependency.kind === 'chain' || dependency.kind === 'chain-start') this.sceneTails.set(shot.sceneKey, { shotId: shot.id, job });
    // Two independent startup shots may establish the same key; the first to register wins.
    else if (dependency.kind === 'anchor-establish' && !this.anchors.has(shot.anchorKey)) this.anchors.set(shot.anchorKey, { shotId: shot.id, job });
  }
}
