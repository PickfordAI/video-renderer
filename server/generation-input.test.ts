import { describe, expect, it, vi } from 'vitest';

import { parseGenerationInput } from './generation-input.js';

describe('parseGenerationInput', () => {
  it('keeps legacy text-only requests compatible', () => {
    expect(parseGenerationInput({
      prompt: 'A cinematic diner at night',
      duration: 5,
      resolution: '480P',
    }, vi.fn())).toEqual({
      prompt: 'A cinematic diner at night',
      duration: 5,
      resolution: '480P',
      aspectRatio: '16:9',
      renderMode: 'auto',
      initialImageUrl: undefined,
      referenceImageUrls: [],
      referenceAudioUrls: [],
      referenceAudioMetadata: [],
    });
  });

  it('resolves built-in assets and preserves ordered HTTPS references', () => {
    const resolveAsset = vi.fn((assetKey: string) => `data:image/jpeg;base64,${assetKey}`);
    const result = parseGenerationInput({
      prompt: 'Image 1 is Kent in the hotel lobby',
      duration: 8,
      resolution: '768P',
      characterReferences: [
        {
          characterName: 'Kent',
          assetKey: 'whispers/kent.jpg',
          audioUrl: 'https://audio.example/kent.mp3',
          audioRole: 'dialogue_performance',
          audioDurationSeconds: 1.724082,
        },
        { characterName: 'Nora', imageUrl: 'https://images.example/nora.jpg' },
      ],
    }, resolveAsset);

    expect(result.referenceImageUrls).toEqual([
      'data:image/jpeg;base64,whispers/kent.jpg',
      'https://images.example/nora.jpg',
    ]);
    expect(resolveAsset).toHaveBeenCalledWith('whispers/kent.jpg');
    expect(result.referenceAudioUrls).toEqual(['https://audio.example/kent.mp3']);
    expect(result.referenceAudioMetadata).toEqual([{
      role: 'dialogue_performance',
      durationSeconds: 1.724082,
    }]);
  });

  it('rejects local URLs because the cloud model cannot fetch them', () => {
    expect(() => parseGenerationInput({
      prompt: 'A cinematic diner at night',
      characterReferences: [{ characterName: 'Kent', imageUrl: 'http://localhost:4173/kent.jpg' }],
    }, vi.fn())).toThrow('HTTPS URL');
  });

  it('keeps the previous referenceImages field compatible', () => {
    const result = parseGenerationInput({
      prompt: 'Image 1 is Kent in the hotel lobby',
      referenceImages: [{ characterName: 'Kent', assetKey: 'whispers/kent.jpg' }],
    }, (assetKey) => `data:image/jpeg;base64,${assetKey}`);

    expect(result.referenceImageUrls).toEqual(['data:image/jpeg;base64,whispers/kent.jpg']);
    expect(result.referenceAudioUrls).toEqual([]);
    expect(result.referenceAudioMetadata).toEqual([]);
  });

  it('accepts explicit modes and inline continuity frames but rejects invalid configuration', () => {
    const input = { prompt: 'A cinematic diner at night', renderMode: 'fal-turbo-i2v' };
    expect(() => parseGenerationInput(input, vi.fn())).toThrow('requires an initial image');
    const initialImageUrl = 'data:image/jpeg;base64,/9j/AAAA';
    expect(parseGenerationInput({ ...input, initialImageUrl }, vi.fn())).toMatchObject({ renderMode: 'fal-turbo-i2v', initialImageUrl });
    expect(() => parseGenerationInput({ ...input, initialImageUrl: 'data:text/html;base64,AAAA' }, vi.fn())).toThrow('HTTPS');
    expect(() => parseGenerationInput({ ...input, initialImageUrl: 'https://name:secret@images.example/scene.jpg' }, vi.fn())).toThrow('credentials');
    expect(() => parseGenerationInput({ ...input, renderMode: 'unknown' }, vi.fn())).toThrow('renderMode');
  });
});
