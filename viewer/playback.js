/**
 * Start a newly attached live stream without leaving the player silently paused.
 * Browsers commonly reject unmuted autoplay, so retry muted and let the native
 * controls give the viewer an immediate path to restore sound.
 */
export async function startLivePlayback(video) {
  try {
    await video.play();
    return video.muted ? 'playing-muted' : 'playing';
  } catch {
    const wasMuted = video.muted;
    video.muted = true;
    try {
      await video.play();
      return 'playing-muted';
    } catch {
      video.muted = wasMuted;
      return 'blocked';
    }
  }
}
