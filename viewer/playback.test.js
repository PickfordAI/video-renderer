import { describe, expect, it, vi } from 'vitest';
import { startLivePlayback } from './playback.js';

describe('startLivePlayback', () => {
  it('starts with sound when the browser permits it', async () => {
    const video = { muted: false, play: vi.fn().mockResolvedValue(undefined) };

    await expect(startLivePlayback(video)).resolves.toBe('playing');
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.muted).toBe(false);
  });

  it('falls back to muted autoplay when sound requires a user gesture', async () => {
    const video = {
      muted: false,
      play: vi.fn().mockRejectedValueOnce(new Error('NotAllowedError')).mockResolvedValueOnce(undefined),
    };

    await expect(startLivePlayback(video)).resolves.toBe('playing-muted');
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(video.muted).toBe(true);
  });

  it('leaves manual playback available when autoplay is completely blocked', async () => {
    const video = { muted: false, play: vi.fn().mockRejectedValue(new Error('blocked')) };

    await expect(startLivePlayback(video)).resolves.toBe('blocked');
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(video.muted).toBe(false);
  });
});
