import { describe, expect, it } from 'vitest';

import { ShotGenerator } from './shot-generation.js';
import type { ShotScheduler } from './shot-scheduler.js';
import type { PlannedShot } from './shot-planner.js';

function shot(id: string, anchorKey = 'anchor-a'): PlannedShot {
  return {
    id, groupId: `group-${id}`, storyBlockId: 'block-1', prompt: `shot ${id}`, durationSeconds: 6,
    referenceImageUrls: [], referenceAudioUrls: [], imageReferences: [], audioReferences: [],
    setupKey: 'setup', continuityKey: 'continuity', sceneKey: 'scene-1', anchorKey, requiresPreviousFrame: true,
  } as unknown as PlannedShot;
}

function generator(independentStartupShots: number): ShotGenerator {
  return new ShotGenerator({
    renderMode: 'fal-max-ref2v', continuity: 'camera-anchors', resolution: '480P', apiKey: 'k',
    scheduler: {} as ShotScheduler<never>, signal: new AbortController().signal, independentStartupShots,
  });
}

describe('startup shot independence', () => {
  it('lets the first two shots establish independently, then reuses the first anchor', () => {
    const shots = generator(2);
    expect(shots.plan(shot('1')).kind).toBe('anchor-establish');
    // Same camera setup as shot 1: would normally wait for its frame, and the audience would see a gap after line one.
    expect(shots.plan(shot('2')).kind).toBe('anchor-establish');
    const third = shots.plan(shot('3'));
    expect(third).toEqual({ kind: 'anchor-reuse', anchorKey: 'anchor-a', sourceShotId: '1' });
  });

  it('keeps strict dependencies when the startup allowance is zero', () => {
    const shots = generator(0);
    expect(shots.plan(shot('1')).kind).toBe('anchor-establish');
    expect(shots.plan(shot('2'))).toEqual({ kind: 'anchor-reuse', anchorKey: 'anchor-a', sourceShotId: '1' });
  });
});
