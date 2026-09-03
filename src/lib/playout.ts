import Hls from 'hls.js';

import type { GeneratedClip } from './types';

export interface PlayoutStatus {
  sessionId: string;
  hlsUrl: string;
  state: 'buffering' | 'starting' | 'streaming' | 'stopped' | 'error';
  normalizedClips: number;
  pendingClips: number;
  currentPosition: number | null;
  playedThroughPosition: number;
  outputSeconds: number;
  error: string | null;
}

async function playoutRequest(url: string, init?: RequestInit): Promise<PlayoutStatus> {
  const response = await fetch(url, init);
  const body = await response.json() as PlayoutStatus & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Playout request failed (${response.status})`);
  return body;
}

export function startPlayout(startupBufferClips: 1 | 2 = 2): Promise<PlayoutStatus> {
  const suffix = startupBufferClips === 1 ? '?startup_buffer_clips=1' : '';
  return playoutRequest(`/api/playout${suffix}`, { method: 'POST' });
}

export function enqueuePlayoutClip(
  sessionId: string,
  clip: GeneratedClip,
  position: number,
): Promise<PlayoutStatus> {
  return playoutRequest(`/api/playout/${encodeURIComponent(sessionId)}/clips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      position,
      storyBlockId: clip.storyBlockId,
      videoUrl: clip.videoUrl,
      durationSeconds: clip.durationSeconds,
    }),
  });
}

export function getPlayoutStatus(sessionId: string): Promise<PlayoutStatus> {
  return playoutRequest(`/api/playout/${encodeURIComponent(sessionId)}`);
}

export function skipPlayoutPosition(sessionId: string, position: number): Promise<PlayoutStatus> {
  return playoutRequest(`/api/playout/${encodeURIComponent(sessionId)}/clips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position, skip: true }),
  });
}

export async function stopPlayout(sessionId: string): Promise<void> {
  const response = await fetch(`/api/playout/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Could not stop playout (${response.status})`);
  }
}

export function attachHlsPlayer(
  video: HTMLVideoElement,
  hlsUrl: string,
  onError: (message: string) => void,
): () => void {
  // Prefer MSE through hls.js. Some embedded Chromium builds report native
  // HLS support from canPlayType(), then reject the playlist during play().
  if (Hls.isSupported()) {
    let manifestRetry: ReturnType<typeof setTimeout> | null = null;
    const hls = new Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 8,
      manifestLoadingMaxRetry: 20,
      levelLoadingMaxRetry: 20,
      fragLoadingMaxRetry: 20,
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.stopLoad();
        if (manifestRetry) clearTimeout(manifestRetry);
        manifestRetry = setTimeout(() => {
          manifestRetry = null;
          hls.loadSource(hlsUrl);
        }, 1_000);
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }
      onError(`Live stream failed: ${data.details}`);
    });
    hls.loadSource(hlsUrl);
    hls.attachMedia(video);
    return () => {
      if (manifestRetry) clearTimeout(manifestRetry);
      hls.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = hlsUrl;
    video.load();
    return () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }

  onError('This browser cannot play the live HLS stream.');
  return () => undefined;
}
