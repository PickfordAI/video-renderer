import { describe, expect, it } from 'vitest';
import { parseRendererConfig } from './render-mode.js';

describe('renderer configuration', () => {
  it('keeps model, continuity, concurrency and buffering independently configurable', () => {
    const base = { model: 'fal-max-ref2v', concurrency: 4, maxBufferedSeconds: 45 };
    expect(parseRendererConfig({ ...base, continuity: 'none' })).toEqual({ ...base, continuity: 'none' });
    expect(parseRendererConfig({ ...base, continuity: 'camera-anchors' })).toEqual({ ...base, continuity: 'camera-anchors' });
  });
  it('preserves old handoff defaults and lets explicit canonical configuration win', () => {
    expect(parseRendererConfig(undefined, { renderMode: 'fal-turbo-i2v', generationConcurrency: 3 })).toEqual({ model: 'fal-turbo-i2v', continuity: 'last-frame-chain', concurrency: 3, maxBufferedSeconds: 30 });
    expect(parseRendererConfig({ model: 'fal-max-ref2v', continuity: 'none', concurrency: 4 }, { renderMode: 'auto', generationConcurrency: 1 })).toMatchObject({ model: 'fal-max-ref2v', continuity: 'none', concurrency: 4 });
    expect(parseRendererConfig(undefined)).toEqual({ model: 'auto', continuity: 'none', concurrency: 2, maxBufferedSeconds: 30 });
  });
  it('rejects unimplemented model/strategy pairs and invalid budgets explicitly', () => {
    expect(() => parseRendererConfig({ model: 'fal-turbo-i2v', continuity: 'camera-anchors' })).toThrow('does not yet support');
    expect(() => parseRendererConfig({ model: 'fal-max-ref2v', continuity: 'last-frame-chain' })).toThrow('does not yet support');
    expect(() => parseRendererConfig({ continuity: 'invented' })).toThrow('continuity');
    expect(() => parseRendererConfig({ concurrency: 9 })).toThrow('concurrency');
    expect(() => parseRendererConfig({ maxBufferedSeconds: 0 })).toThrow('maxBufferedSeconds');
    expect(() => parseRendererConfig([])).toThrow('must be an object');
  });
});
