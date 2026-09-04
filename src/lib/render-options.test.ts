import { describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_OPTIONS, buildShotPlannerSettings, externalRenderOptions, loadRenderOptions, rendererConfigFromSettings, renderSettingsError, withRenderModel } from './render-options';
import type { RendererSettings } from './types';

const settings = (override: Partial<RendererSettings> = {}) => ({
  ...DEFAULT_RENDER_OPTIONS, duration: 5, resolution: '480P', useCharacterReferences: false,
  characterReferences: [{ characterName: 'Lily', imageUrl: 'https://example.com/lily.jpg', audioUrl: 'https://example.com/voice.mp3', description: 'Blue coat' }],
  ...override,
} as RendererSettings);

describe('explicit render options', () => {
  it('preserves the selected mode and valid lookahead preferences across serialization', () => {
    const value = settings({ renderMode: 'fal-turbo-i2v', continuityStrategy: 'last-frame-chain', initialImageUrl: 'https://example.com/scene.jpg', generationConcurrency: 3, maxBufferedSeconds: 45 });
    expect(loadRenderOptions(JSON.parse(JSON.stringify(value)))).toMatchObject({ renderMode: 'fal-turbo-i2v', generationConcurrency: 3, maxBufferedSeconds: 45 });
    expect(loadRenderOptions({})).toEqual(DEFAULT_RENDER_OPTIONS);
  });

  it('requires fal and image grounding before starting explicit fal modes', () => {
    expect(renderSettingsError(settings({ renderMode: 'fal-turbo-i2v', continuityStrategy: 'last-frame-chain' }), { anyKeyConfigured: true, falKeyConfigured: false })).toContain('FAL_KEY');
    expect(renderSettingsError(settings({ renderMode: 'fal-turbo-i2v', continuityStrategy: 'last-frame-chain' }))).toContain('initial scene image');
    expect(renderSettingsError(settings({ renderMode: 'fal-max-ref2v', characterReferences: [] }))).toContain('reference');
    expect(renderSettingsError(settings({ renderMode: 'fal-max-ref2v' }))).toBeNull();
    expect(renderSettingsError(settings({ initialImageUrl: 'http://example.com/image.jpg' }))).toContain('HTTPS');
  });

  it('carries named references and bounded voice metadata to the connected planner', () => {
    const value = settings({ renderMode: 'fal-max-ref2v' });
    expect(buildShotPlannerSettings(value).characters?.Lily).toMatchObject({ name: 'Lily', imageUrl: 'https://example.com/lily.jpg', description: 'Blue coat' });
    expect(buildShotPlannerSettings(value).characters?.Lily.voice).toBeUndefined();
    value.characterReferences[0].audioDurationSeconds = 4;
    expect(externalRenderOptions(value)).toMatchObject({ rendererConfig: { model: 'fal-max-ref2v', continuity: 'none', concurrency: 2, maxBufferedSeconds: 30 }, shotPlanner: { characters: { Lily: { voice: { url: 'https://example.com/voice.mp3', durationSeconds: 4 } } } } });
    expect(buildShotPlannerSettings(settings({ renderMode: 'fal-turbo-i2v', continuityStrategy: 'last-frame-chain' })).useDialogueAudioReferences).toBe(false);
  });
});

describe('retired bundled reference migration', () => {
  it('omits legacy local paths from the connected planner while keeping a scene image', async () => {
    const { loadCharacterReferences } = await import('./character-references');
    const refs = loadCharacterReferences([{ characterName: 'Lily', imageUrl: '/reference-assets/whispers/lily.jpg', audioUrl: '/reference-assets/voice.mp3' }]);
    expect(refs[0]).toMatchObject({ imageUrl: '', audioUrl: '' });
    const value = settings({ renderMode: 'fal-max-ref2v', initialImageUrl: 'https://example.com/scene.jpg', characterReferences: refs });
    expect(renderSettingsError(value)).toBeNull();
    expect(buildShotPlannerSettings(value).characters?.Lily).not.toHaveProperty('imageUrl');
    expect(buildShotPlannerSettings(settings({ ...value, characterReferences: [{ characterName: 'Lily', imageUrl: '/reference-assets/whispers/lily.jpg', audioUrl: '' }] })).characters?.Lily).not.toHaveProperty('imageUrl');
  });
});

describe('independent continuity preferences', () => {
  it('migrates old mode-only preferences to their former behavior', () => {
    expect(loadRenderOptions({ renderMode: 'fal-turbo-i2v' }).continuityStrategy).toBe('last-frame-chain');
    expect(loadRenderOptions({ renderMode: 'fal-max-ref2v' }).continuityStrategy).toBe('camera-anchors');
    expect(loadRenderOptions({ renderMode: 'fal-max-ref2v', continuityStrategy: 'none' }).continuityStrategy).toBe('none');
  });
  it('preserves compatible strategies when changing models and exposes the necessary default', () => {
    const independent = settings({ renderMode: 'auto', continuityStrategy: 'none', generationConcurrency: 4 });
    expect(withRenderModel(independent, 'fal-max-ref2v')).toMatchObject({ continuityStrategy: 'none', generationConcurrency: 4 });
    const chained = withRenderModel(independent, 'fal-turbo-i2v');
    expect(chained).toMatchObject({ continuityStrategy: 'last-frame-chain', generationConcurrency: 4 });
    expect(withRenderModel(chained, 'fal-max-ref2v').continuityStrategy).toBe('camera-anchors');
    expect(rendererConfigFromSettings(chained)).toEqual({ model: 'fal-turbo-i2v', continuity: 'last-frame-chain', concurrency: 4, maxBufferedSeconds: 30 });
  });
});
