let unlockedAudioContext: AudioContext | null = null;

interface PlayableMedia {
  muted: boolean;
  volume: number;
  play(): Promise<void>;
}

function clampVolume(volume: number): number {
  return Math.max(0, Math.min(1, volume));
}

export function playMediaMuted(media: PlayableMedia, volume: number): Promise<void> {
  media.muted = true;
  media.volume = clampVolume(volume);
  return media.play();
}

export function playMediaWithSound(media: PlayableMedia, volume: number): Promise<void> {
  media.muted = false;
  media.volume = clampVolume(volume);
  return media.play();
}

// This must be called directly from the user's click. Room creation and video
// generation happen later, so prime the document's media session before either
// asynchronous workflow begins.
export async function unlockMediaPlayback(): Promise<void> {
  let contextResume: Promise<void> | null = null;
  if (typeof AudioContext !== 'undefined') {
    if (!unlockedAudioContext || unlockedAudioContext.state === 'closed') {
      unlockedAudioContext = new AudioContext();
    }
    contextResume = unlockedAudioContext.resume().catch(() => undefined);
  }

  if (typeof Audio === 'undefined') {
    await contextResume;
    return;
  }

  const unlock = new Audio();
  unlock.muted = true;
  const playback = unlock.play();
  await Promise.all([contextResume, playback?.catch(() => undefined)]);
}
