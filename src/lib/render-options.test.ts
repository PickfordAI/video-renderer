import { describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_OPTIONS, buildShotPlannerSettings, externalRenderOptions, loadRenderOptions, renderSettingsError } from './render-options';
import type { RendererSettings } from './types';

const settings = (override: Partial<RendererSettings> = {}) => ({
  ...DEFAULT_RENDER_OPTIONS, duration: 5, resolution: '480P', useCharacterReferences: false,
  characterReferences: [{ characterName: 'Lily', imageUrl: 'https://example.com/lily.jpg', audioUrl: 'https://example.com/voice.mp3', description: 'Blue coat' }],
  ...override,
} as RendererSettings);

describe('explicit render options', () => {
  it('preserves the selected mode and valid lookahead preferences across serialization', () => {
    const value = settings({ renderMode: 'fal-turbo-i2v', initialImageUrl: 'https://example.com/scene.jpg', generationConcurrency: 3, maxBufferedSeconds: 45 });
    expect(loadRenderOptions(JSON.parse(JSON.stringify(value)))).toMatchObject({ renderMode: 'fal-turbo-i2v', generationConcurrency: 3, maxBufferedSeconds: 45 });
    expect(loadRenderOptions({})).toEqual(DEFAULT_RENDER_OPTIONS);
  });

  it('requires fal and image grounding before starting explicit fal modes', () => {
    expect(renderSettingsError(settings({ renderMode: 'fal-turbo-i2v' }), { anyKeyConfigured: true, falKeyConfigured: false })).toContain('FAL_KEY');
    expect(renderSettingsError(settings({ renderMode: 'fal-turbo-i2v' }))).toContain('initial scene image');
    expect(renderSettingsError(settings({ renderMode: 'fal-max-ref2v', characterReferences: [] }))).toContain('reference');
    expect(renderSettingsError(settings({ renderMode: 'fal-max-ref2v' }))).toBeNull();
    expect(renderSettingsError(settings({ initialImageUrl: 'http://example.com/image.jpg' }))).toContain('HTTPS');
  });

  it('carries named references and bounded voice metadata to the connected planner', () => {
    const value = settings({ renderMode: 'fal-max-ref2v' });
    expect(buildShotPlannerSettings(value).characters?.Lily).toMatchObject({ name: 'Lily', imageUrl: 'https://example.com/lily.jpg', description: 'Blue coat' });
    expect(buildShotPlannerSettings(value).characters?.Lily.voice).toBeUndefined();
    value.characterReferences[0].audioDurationSeconds = 4;
    expect(externalRenderOptions(value)).toMatchObject({ renderMode: 'fal-max-ref2v', generationConcurrency: 2, maxBufferedSeconds: 30, shotPlanner: { characters: { Lily: { voice: { url: 'https://example.com/voice.mp3', durationSeconds: 4 } } } } });
    expect(buildShotPlannerSettings(settings({ renderMode: 'fal-turbo-i2v' })).useDialogueAudioReferences).toBe(false);
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
