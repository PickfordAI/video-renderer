import { parseRendererConfig } from '../server/render-mode.ts';
import { describe, expect, it } from 'vitest';
import { handoffRendererConfig, renderingOptions, validateHandoff } from './handoff.mjs';
const valid = () => ({ rendererId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', credentialId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', evdId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', clientSecret: 'test', setupToken: 'test' });
describe('handoff validation before provisioning', () => {
  it('accepts local Docker handoffs without permitting them for hosted workers', () => {
    const handoff = { ...valid(), environment: 'local', services: { narrativeEngineUrl: 'http://host.docker.internal:8181' } };
    expect(validateHandoff(handoff)).toEqual(handoff);
    expect(() => validateHandoff(handoff, true)).toThrow();
  });
  it('accepts an onboarding handoff', () => expect(validateHandoff(valid())).toEqual(valid()));
  it('rejects credentials, duration and version mistakes before creating a room', () => {
    for (const change of [{ rendererId: 'wrong' }, { clientSecret: '' }, { clipDurationSeconds: 99 }, { rendererVersion: 'v1' }, { environment: 'wrong' }]) expect(() => validateHandoff({ ...valid(), ...change })).toThrow();
  });
  it('rejects local and credential-bearing URLs for hosted workers', () => {
    for (const url of ['http://127.0.0.1:8281', 'https://localhost', 'https://token@example.com', 'https://example.com?token=secret']) expect(() => validateHandoff({ ...valid(), services: { narrativeEngineUrl: url } }, true)).toThrow();
  });
});

describe('render mode handoff', () => {
  it('retains explicit modes, image grounding, and scheduler settings', () => {
    const shotPlanner = { characters: { Lily: { name: 'Lily', imageUrl: 'https://example.com/lily.jpg', voice: { url: 'https://example.com/lily.mp3', durationSeconds: 4 } } } };
    const handoff = { ...valid(), renderMode: 'fal-max-ref2v', generationConcurrency: 3, maxBufferedSeconds: 25, shotPlanner };
    expect(validateHandoff(handoff)).toBe(handoff);
    expect(renderingOptions(handoff)).toMatchObject({ rendererConfig: { model: 'fal-max-ref2v', continuity: 'camera-anchors', concurrency: 3, maxBufferedSeconds: 25 }, shotPlanner });
    expect(renderingOptions({ renderMode: 'fal-turbo-i2v', initialImageUrl: 'https://example.com/scene.jpg' })).toMatchObject({ rendererConfig: { model: 'fal-turbo-i2v', continuity: 'last-frame-chain', concurrency: 2, maxBufferedSeconds: 30 } });
  });
  it('rejects incomplete models and unsafe reference settings before provisioning', () => {
    for (const change of [{ renderMode: 'typo' }, { renderMode: 'fal-turbo-i2v' }, { renderMode: 'fal-max-ref2v' }, { generationConcurrency: 9 }, { maxBufferedSeconds: 0 }, { initialImageUrl: 'http://example.com/scene.jpg' }, { shotPlanner: { characters: { Lily: { imageUrl: 'https://example.com/lily.jpg', voice: { url: 'https://example.com/voice.mp3', durationSeconds: 20 } } } } }]) {
      expect(() => validateHandoff({ ...valid(), ...change })).toThrow();
    }
  });
});

describe('separate model and continuity policy', () => {
  it('keeps CLI capability validation in agreement with the shared server schema', () => {
    for (const model of ['auto', 'fal-turbo-i2v', 'fal-max-ref2v']) for (const continuity of ['none', 'last-frame-chain', 'camera-anchors']) {
      const rendererConfig = { model, continuity, concurrency: 3, maxBufferedSeconds: 25 };
      let parsed;
      try { parsed = parseRendererConfig(rendererConfig); } catch {
        expect(() => handoffRendererConfig({ rendererConfig })).toThrow();
        continue;
      }
      expect(handoffRendererConfig({ rendererConfig })).toEqual(parsed);
    }
  });
  it('prefers canonical options and rejects unsupported combinations before provisioning', () => {
    const rendererConfig = { model: 'fal-max-ref2v', continuity: 'none', concurrency: 4, maxBufferedSeconds: 40 };
    const value = { ...valid(), rendererConfig, renderMode: 'fal-turbo-i2v', generationConcurrency: 1, maxBufferedSeconds: 15, initialImageUrl: 'https://example.com/scene.jpg' };
    expect(renderingOptions(value).rendererConfig).toEqual(rendererConfig);
    for (const continuity of ['none', 'camera-anchors']) expect(() => validateHandoff({ ...value, rendererConfig: { ...rendererConfig, model: 'fal-turbo-i2v', continuity } })).toThrow('does not yet support');
  });
});
