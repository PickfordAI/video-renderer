import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('unlockMediaPlayback', () => {
  it('primes Web Audio and HTML media from the launch gesture', async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    const play = vi.fn().mockResolvedValue(undefined);
    class FakeAudioContext {
      state: AudioContextState = 'suspended';
      resume = resume;
    }
    class FakeAudio {
      muted = false;
      play = play;
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('Audio', FakeAudio);

    const { unlockMediaPlayback } = await import('./media-unlock');
    await unlockMediaPlayback();

    expect(resume).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
  });

  it('still unlocks HTML media when Web Audio is unavailable', async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    class FakeAudio {
      muted = false;
      play = play;
    }
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('Audio', FakeAudio);

    const { unlockMediaPlayback } = await import('./media-unlock');
    await expect(unlockMediaPlayback()).resolves.toBeUndefined();
    expect(play).toHaveBeenCalledOnce();
  });
});

describe('playMediaWithSound', () => {
  it('starts the real stream with sound from the playback gesture', async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const media = { muted: true, volume: 0, play };
    const { playMediaWithSound } = await import('./media-unlock');

    await playMediaWithSound(media, 0.85);

    expect(media.muted).toBe(false);
    expect(media.volume).toBe(0.85);
    expect(play).toHaveBeenCalledOnce();
  });
});

describe('playMediaMuted', () => {
  it('starts consuming the real stream silently while the sound gesture is pending', async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const media = { muted: false, volume: 0, play };
    const { playMediaMuted } = await import('./media-unlock');

    await playMediaMuted(media, 1.5);

    expect(media.muted).toBe(true);
    expect(media.volume).toBe(1);
    expect(play).toHaveBeenCalledOnce();
  });
});
