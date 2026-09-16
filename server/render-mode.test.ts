import { describe, expect, it } from 'vitest';
import { defaultContinuity, parseRenderMode, parseRendererConfig, RENDER_MODE_LABELS, RENDER_MODES } from './render-mode.js';

describe('renderer configuration', () => {
  it('keeps model, continuity, concurrency and buffering independently configurable', () => {
    const base = { model: 'fal-max-ref2v', concurrency: 4, maxBufferedSeconds: 45 };
    expect(parseRendererConfig({ ...base, continuity: 'none' })).toEqual({ ...base, continuity: 'none' });
    expect(parseRendererConfig({ ...base, continuity: 'camera-anchors' })).toEqual({ ...base, continuity: 'camera-anchors' });
  });
  it('preserves old handoff defaults and lets explicit canonical configuration win', () => {
    expect(parseRendererConfig(undefined, { renderMode: 'fal-turbo-i2v', generationConcurrency: 3 })).toEqual({ model: 'fal-turbo-i2v', continuity: 'last-frame-chain', concurrency: 3, maxBufferedSeconds: 45 });
    expect(parseRendererConfig({ model: 'fal-max-ref2v', continuity: 'none', concurrency: 4 }, { renderMode: 'auto', generationConcurrency: 1 })).toMatchObject({ model: 'fal-max-ref2v', continuity: 'none', concurrency: 4 });
    expect(parseRendererConfig(undefined)).toEqual({ model: 'auto', continuity: 'none', concurrency: 4, maxBufferedSeconds: 45 });
  });
  it('keeps template as the implicit prompt policy and validates opt-in LLM mode', () => {
    expect(parseRendererConfig({ model: 'fal-max-ref2v' }).promptMode).toBeUndefined();
    expect(parseRendererConfig({ model: 'fal-max-ref2v', promptMode: 'llm' }).promptMode).toBe('llm');
    expect(() => parseRendererConfig({ model: 'single-frame', promptMode: 'llm' })).toThrow('require fal-max-ref2v');
    expect(() => parseRendererConfig({ model: 'fal-max-ref2v', promptMode: 'other' })).toThrow('promptMode');
  });
  it('rejects unimplemented model/strategy pairs and invalid budgets explicitly', () => {
    expect(() => parseRendererConfig({ model: 'fal-turbo-i2v', continuity: 'camera-anchors' })).toThrow('does not yet support');
    expect(() => parseRendererConfig({ model: 'fal-max-ref2v', continuity: 'last-frame-chain' })).toThrow('does not yet support');
    expect(() => parseRendererConfig({ continuity: 'invented' })).toThrow('continuity');
    expect(() => parseRendererConfig({ concurrency: 17 })).toThrow('concurrency');
    expect(() => parseRendererConfig({ maxBufferedSeconds: 0 })).toThrow('maxBufferedSeconds');
    expect(() => parseRendererConfig([])).toThrow('must be an object');
  });
  // PIC-1971: the stills mode holds one generated frame per line, so it has no frame to chain
  // from and no camera anchor to establish. Only `none` is a coherent continuity for it.
  it('registers single-frame as a stills mode that supports no continuity but none', () => {
    expect(defaultContinuity('single-frame')).toBe('none');
    expect(parseRendererConfig({ model: 'single-frame' })).toEqual({ model: 'single-frame', continuity: 'none', concurrency: 4, maxBufferedSeconds: 45 });
    expect(() => parseRendererConfig({ model: 'single-frame', continuity: 'last-frame-chain' })).toThrow('does not yet support');
    expect(() => parseRendererConfig({ model: 'single-frame', continuity: 'camera-anchors' })).toThrow('does not yet support');
    expect(parseRenderMode('single-frame')).toBe('single-frame');
    expect(() => parseRenderMode('single-frames')).toThrow('single-frame');
    // Every mode carries a creator-facing label; the picker reads them straight out of this map.
    for (const mode of RENDER_MODES) expect(RENDER_MODE_LABELS[mode]).toBeTruthy();
  });
});
