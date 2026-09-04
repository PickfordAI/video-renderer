import { describe, expect, it } from 'vitest';

import {
  hasOpeningPlaybackRunway,
  nextReadyTimelineClip,
  orderClipsByTimeline,
  RenderPipeline,
} from './render-pipeline';
import type { GeneratedClip, StoryBeat } from './types';

function beat(id: string): StoryBeat {
  return { storyBlockId: id, sceneIndex: 0, blockIndex: 0, prompt: id, sequence: 1 };
}

function clip(id: string): GeneratedClip {
  return {
    id: `clip-${id}`,
    storyBlockId: id,
    prompt: id,
    videoUrl: `https://video.example/${id}.mp4`,
    requestId: id,
    createdAt: 1,
    durationSeconds: 5,
    totalSeconds: 10,
    generationMs: 10_000,
    generationMode: 'text',
    referenceCharacters: [],
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RenderPipeline', () => {
  it('keeps completed clips in story order and waits for a missing earlier shot', () => {
    const timeline = [beat('one'), beat('two'), beat('three')];
    const clips = new Map([
      ['two', clip('two')],
      ['three', clip('three')],
    ]);
    expect(orderClipsByTimeline(timeline, clips).map((item) => item.storyBlockId)).toEqual(['two', 'three']);
    expect(nextReadyTimelineClip(timeline, clips, new Set(), 0)).toBeNull();
    clips.set('one', clip('one'));
    expect(nextReadyTimelineClip(timeline, clips, new Set(), 0)).toMatchObject({
      clip: { storyBlockId: 'one' },
      index: 0,
    });
    expect(nextReadyTimelineClip(timeline, clips, new Set(['one']), 0)).toMatchObject({
      clip: { storyBlockId: 'two' },
      index: 1,
    });
  });

  it('holds the opening clip until its known successor is ready', () => {
    const timeline = [beat('one'), beat('two')];
    const clips = new Map([['one', clip('one')]]);
    const renderingSecond = { queuedIds: [], activeIds: ['one', 'two'], failedIds: [] };

    expect(hasOpeningPlaybackRunway(timeline, clips, renderingSecond, 0)).toBe(false);
    clips.set('two', clip('two'));
    expect(hasOpeningPlaybackRunway(timeline, clips, renderingSecond, 0)).toBe(true);
  });

  it('does not deadlock a one-shot opening or a failed successor', () => {
    const clips = new Map([['one', clip('one')]]);
    expect(hasOpeningPlaybackRunway(
      [beat('one')],
      clips,
      { queuedIds: [], activeIds: ['one'], failedIds: [] },
      0,
    )).toBe(true);
    expect(hasOpeningPlaybackRunway(
      [beat('one'), beat('two')],
      clips,
      { queuedIds: [], activeIds: ['one'], failedIds: ['two'] },
      0,
    )).toBe(true);
  });

  it('keeps a bounded number of jobs active and never submits a beat twice', async () => {
    const resolvers = new Map<string, (value: GeneratedClip) => void>();
    const started: string[] = [];
    const completed: string[] = [];
    const pipeline = new RenderPipeline({
      concurrency: 2,
      retries: 0,
      render: (next) => {
        started.push(next.storyBlockId);
        return new Promise((resolve) => resolvers.set(next.storyBlockId, resolve));
      },
      onClip: (next) => completed.push(next.storyBlockId),
      onError: () => {},
    });

    pipeline.enqueue([beat('one'), beat('two'), beat('three'), beat('two')]);
    expect(started).toEqual(['one', 'two']);
    expect(pipeline.snapshot().queuedIds).toEqual(['three']);

    resolvers.get('two')?.(clip('two'));
    await flush();
    expect(started).toEqual(['one', 'two', 'three']);
    expect(completed).toEqual(['two']);
  });

  it('retries a failed render once before reporting a terminal failure', async () => {
    let attempts = 0;
    const failures: string[] = [];
    const pipeline = new RenderPipeline({
      concurrency: 1,
      retries: 1,
      render: async () => {
        attempts += 1;
        throw new Error('provider unavailable');
      },
      onClip: () => {},
      onError: (next) => failures.push(next.storyBlockId),
    });

    pipeline.enqueue([beat('one')]);
    await flush();
    await flush();
    expect(attempts).toBe(2);
    expect(failures).toEqual(['one']);
    expect(pipeline.snapshot().failedIds).toEqual(['one']);
  });

  it('ignores in-flight results after the pipeline is cleared', async () => {
    let resolveRender: ((value: GeneratedClip) => void) | undefined;
    let renderSignal: AbortSignal | undefined;
    const completed: string[] = [];
    const pipeline = new RenderPipeline({
      render: (_next, signal) => {
        renderSignal = signal;
        return new Promise((resolve) => { resolveRender = resolve; });
      },
      onClip: (next) => completed.push(next.storyBlockId),
      onError: () => {},
    });
    pipeline.enqueue([beat('one')]);
    pipeline.clear();
    expect(renderSignal?.aborted).toBe(true);
    resolveRender?.(clip('one'));
    await flush();
    expect(completed).toEqual([]);
    expect(pipeline.snapshot()).toEqual({ queuedIds: [], activeIds: [], failedIds: [] });
  });
  it('waits at the lookahead limit and resumes when playback frees capacity', async () => {
    const started: string[] = [];
    let buffered = 0;
    const pipeline = new RenderPipeline({
      concurrency: () => 1,
      canStart: () => buffered < 1,
      render: async next => { started.push(next.storyBlockId); buffered += 1; return clip(next.storyBlockId); },
      onClip: () => {}, onError: () => {},
    });
    pipeline.enqueue([beat('one'), beat('two')]);
    await flush();
    expect(started).toEqual(['one']);
    expect(pipeline.snapshot().queuedIds).toEqual(['two']);
    buffered = 0;
    pipeline.resume();
    await flush();
    expect(started).toEqual(['one', 'two']);
  });

});
