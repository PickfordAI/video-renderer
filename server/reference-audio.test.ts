import { describe, expect, it, vi } from 'vitest';

import { prepareReferenceAudioUrls } from './reference-audio.js';

describe('prepareReferenceAudioUrls', () => {
  it('pads an exact dialogue performance below H3 Max\'s two-second minimum', async () => {
    const padAudio = vi.fn().mockResolvedValue('data:audio/mpeg;base64,PADDED');

    await expect(prepareReferenceAudioUrls(
      ['https://audio.example/marcus-short.mp3'],
      [{ role: 'dialogue_performance', durationSeconds: 1.724082 }],
      { padAudio },
    )).resolves.toEqual(['data:audio/mpeg;base64,PADDED']);
    expect(padAudio).toHaveBeenCalledWith('https://audio.example/marcus-short.mp3');
  });

  it('normalizes valid dialogue without changing canonical voice samples', async () => {
    const padAudio = vi.fn().mockResolvedValue('data:audio/mpeg;base64,NORMALIZED');
    const urls = [
      'https://audio.example/june-line.mp3',
      'https://audio.example/marcus-voice.mp3',
    ];

    await expect(prepareReferenceAudioUrls(urls, [
      { role: 'dialogue_performance', durationSeconds: 2 },
      { role: 'voice_sample', durationSeconds: 1.5 },
    ], { padAudio })).resolves.toEqual([
      'data:audio/mpeg;base64,NORMALIZED',
      'https://audio.example/marcus-voice.mp3',
    ]);
    expect(padAudio).toHaveBeenCalledOnce();
    expect(padAudio).toHaveBeenCalledWith('https://audio.example/june-line.mp3');
  });

  it('normalizes exact dialogue when duration metadata is absent', async () => {
    const padAudio = vi.fn().mockResolvedValue('data:audio/mpeg;base64,NORMALIZED');
    const urls = ['https://audio.example/unknown-duration.mp3'];

    await expect(prepareReferenceAudioUrls(
      urls,
      [{ role: 'dialogue_performance' }],
      { padAudio },
    )).resolves.toEqual(['data:audio/mpeg;base64,NORMALIZED']);
    expect(padAudio).toHaveBeenCalledWith('https://audio.example/unknown-duration.mp3');
  });
});
