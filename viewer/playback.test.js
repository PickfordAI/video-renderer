import { describe, expect, it, vi } from 'vitest';
import { startLivePlayback, syncPlaybackUi } from './playback.js';

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

describe('syncPlaybackUi', () => {
  it('leaves the account open and audience controls hidden before playback begins', () => {
    const chat = { hidden: true };
    const creatorDetails = { open: true };
    const bundlesDetails = { open: true };

    syncPlaybackUi({ playbackStarted: false, chatReady: true, chat, creatorDetails, bundlesDetails });

    expect(chat.hidden).toBe(true);
    expect(creatorDetails.open).toBe(true);
    expect(bundlesDetails.open).toBe(true);
  });

  it('collapses the account and StoryBundles and reveals ready audience controls once playback begins', () => {
    const chat = { hidden: true };
    const creatorDetails = { open: true };
    const bundlesDetails = { open: true };

    syncPlaybackUi({ playbackStarted: true, chatReady: true, chat, creatorDetails, bundlesDetails });

    expect(chat.hidden).toBe(false);
    expect(creatorDetails.open).toBe(false);
    expect(bundlesDetails.open).toBe(false);
  });

  it('keeps audience controls hidden when playback begins before chat is ready', () => {
    const chat = { hidden: true };
    const creatorDetails = { open: true };
    const bundlesDetails = { open: true };

    syncPlaybackUi({ playbackStarted: true, chatReady: false, chat, creatorDetails, bundlesDetails });

    expect(chat.hidden).toBe(true);
    expect(creatorDetails.open).toBe(false);
    expect(bundlesDetails.open).toBe(false);
  });
});
