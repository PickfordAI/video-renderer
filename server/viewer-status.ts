import type { ExternalRendererRunStatus } from './external-renderer.js';

// Deliberate allowlist: diagnostics, credentials and service addresses never enter the page.
export function viewerStatus(setup: { ready: boolean; missing: string[] }, run: ExternalRendererRunStatus | null) {
  return {
    setup,
    story: run ? {
      state: run.state,
      hlsUrl: ['connecting', 'running'].includes(run.state) ? run.hlsUrl : null,
    } : null,
  };
}
