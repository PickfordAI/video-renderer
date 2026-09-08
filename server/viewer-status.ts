import type { ExternalRendererRunStatus } from './external-renderer.js';

// Deliberate allowlist: diagnostics, credentials and service addresses never enter the page.
export function viewerStatus(setup: { ready: boolean; missing: string[] }, run: ExternalRendererRunStatus | null) {
  // The relay publishes an HLS manifest before generated video reaches playout. Attaching hls.js
  // to that early manifest can leave a browser following filler until it reconnects. The local
  // home page waits for an actual clip to enter playout before it receives the stream capability.
  const playbackStarted = !run?.fakeClips && (run?.clips?.some(clip => clip.playedAt !== null) ?? false);
  return {
    setup,
    story: run ? {
      state: run.state,
      hlsUrl: ['connecting', 'running'].includes(run.state) && playbackStarted ? run.hlsUrl : null,
    } : null,
  };
}
