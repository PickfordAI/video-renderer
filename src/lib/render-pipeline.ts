import type { GeneratedClip, StoryBeat } from './types';

export interface RenderPipelineSnapshot {
  queuedIds: string[];
  activeIds: string[];
  failedIds: string[];
}

export function orderClipsByTimeline(
  timeline: StoryBeat[],
  clipsByBeat: Map<string, GeneratedClip>,
): GeneratedClip[] {
  return timeline
    .map((beat) => clipsByBeat.get(beat.storyBlockId))
    .filter((clip): clip is GeneratedClip => Boolean(clip));
}

export function nextReadyTimelineClip(
  timeline: StoryBeat[],
  clipsByBeat: Map<string, GeneratedClip>,
  failedIds: Set<string>,
  cursor: number,
): { clip: GeneratedClip; index: number } | null {
  for (let index = cursor; index < timeline.length; index += 1) {
    const beatId = timeline[index].storyBlockId;
    if (failedIds.has(beatId)) continue;
    const clip = clipsByBeat.get(beatId);
    return clip ? { clip, index } : null;
  }
  return null;
}

export function hasOpeningPlaybackRunway(
  timeline: StoryBeat[],
  clipsByBeat: Map<string, GeneratedClip>,
  snapshot: RenderPipelineSnapshot,
  cursor: number,
): boolean {
  const failedIds = new Set(snapshot.failedIds);
  const opening = nextReadyTimelineClip(timeline, clipsByBeat, failedIds, cursor);
  if (!opening) return false;

  for (let index = opening.index + 1; index < timeline.length; index += 1) {
    const successorId = timeline[index].storyBlockId;
    if (failedIds.has(successorId)) continue;
    return clipsByBeat.has(successorId);
  }

  const unfinishedIds = [...snapshot.activeIds, ...snapshot.queuedIds];
  return unfinishedIds.every((id) => id === opening.clip.storyBlockId);
}

interface QueueItem {
  beat: StoryBeat;
  attempts: number;
}

interface RenderPipelineOptions {
  concurrency?: number | (() => number);
  canStart?: (beat: StoryBeat) => boolean;
  retries?: number;
  render: (beat: StoryBeat, signal: AbortSignal) => Promise<GeneratedClip>;
  onClip: (beat: StoryBeat, clip: GeneratedClip) => void;
  onError: (beat: StoryBeat, error: Error) => void;
  onState?: (snapshot: RenderPipelineSnapshot) => void;
}

export class RenderPipeline {
  private readonly concurrency: number | (() => number);
  private readonly canStart?: (beat: StoryBeat) => boolean;
  private readonly retries: number;
  private readonly render: RenderPipelineOptions['render'];
  private readonly onClip: RenderPipelineOptions['onClip'];
  private readonly onError: RenderPipelineOptions['onError'];
  private readonly onState?: RenderPipelineOptions['onState'];
  private readonly knownIds = new Set<string>();
  private readonly active = new Map<string, QueueItem>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly failedIds = new Set<string>();
  private queue: QueueItem[] = [];
  private generation = 0;

  constructor(options: RenderPipelineOptions) {
    this.concurrency = options.concurrency ?? 3;
    this.canStart = options.canStart;
    this.retries = Math.max(0, options.retries ?? 1);
    this.render = options.render;
    this.onClip = options.onClip;
    this.onError = options.onError;
    this.onState = options.onState;
  }

  enqueue(beats: StoryBeat[]): void {
    for (const beat of beats) {
      if (this.knownIds.has(beat.storyBlockId)) continue;
      this.knownIds.add(beat.storyBlockId);
      this.queue.push({ beat, attempts: 0 });
    }
    this.emit();
    this.pump();
  }

  clear(): void {
    this.generation += 1;
    for (const controller of this.activeControllers.values()) controller.abort();
    this.queue = [];
    this.active.clear();
    this.activeControllers.clear();
    this.knownIds.clear();
    this.failedIds.clear();
    this.emit();
  }

  resume(): void { this.pump(); }

  snapshot(): RenderPipelineSnapshot {
    return {
      queuedIds: this.queue.map(({ beat }) => beat.storyBlockId),
      activeIds: [...this.active.keys()],
      failedIds: [...this.failedIds],
    };
  }

  private emit(): void {
    this.onState?.(this.snapshot());
  }

  private pump(): void {
    const concurrency = Math.max(1, typeof this.concurrency === 'function' ? this.concurrency() : this.concurrency);
    while (this.active.size < concurrency && this.queue.length > 0) {
      if (this.canStart && !this.canStart(this.queue[0].beat)) break;
      const item = this.queue.shift();
      if (!item) break;
      const id = item.beat.storyBlockId;
      const generation = this.generation;
      const controller = new AbortController();
      item.attempts += 1;
      this.active.set(id, item);
      this.activeControllers.set(id, controller);
      this.emit();
      void this.render(item.beat, controller.signal)
        .then((clip) => {
          if (generation !== this.generation) return;
          this.failedIds.delete(id);
          this.onClip(item.beat, clip);
        })
        .catch((cause: unknown) => {
          if (generation !== this.generation) return;
          const error = cause instanceof Error ? cause : new Error('Video generation failed');
          if (item.attempts <= this.retries) {
            this.queue.unshift(item);
          } else {
            this.failedIds.add(id);
            this.onError(item.beat, error);
          }
        })
        .finally(() => {
          if (generation !== this.generation) return;
          this.active.delete(id);
          this.activeControllers.delete(id);
          this.emit();
          this.pump();
        });
    }
  }
}
