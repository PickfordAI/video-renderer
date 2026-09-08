import { describe, expect, it } from 'vitest';
import { viewerStatus } from './viewer-status.js';
import type { ExternalRendererRunStatus } from './external-renderer.js';

describe('local viewer status', () => {
  it('exposes only readiness and playback, never runtime identities or diagnostics', () => {
    const run = { state: 'running', hlsUrl: 'http://localhost:4174/hls/example/index.m3u8', clips: [{ playedAt: '2026-09-07T13:08:34Z' }], rendererId: 'private-id', failures: ['private-diagnostic'], clientSecret: 'private-secret' } as unknown as ExternalRendererRunStatus;
    const result = viewerStatus({ ready: true, missing: [] }, run);
    expect(result.story).toEqual({ state: 'running', hlsUrl: run.hlsUrl });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('clears playback after stop/failure and supports an unconfigured worker', () => {
    expect(viewerStatus({ ready: false, missing: ['storyAccess'] }, null).story).toBeNull();
    for (const state of ['stopped', 'failed'] as const) {
      expect(viewerStatus({ ready: true, missing: [] }, { state, hlsUrl: 'https://story.example/old.m3u8' } as ExternalRendererRunStatus).story?.hlsUrl).toBeNull();
    }
  });
  it('does not attach the local player to the relay before generated video enters playout', () => {
    const run = { state: 'running', hlsUrl: 'http://localhost:4174/hls/example/index.m3u8', clips: [{ playedAt: null }] } as unknown as ExternalRendererRunStatus;
    expect(viewerStatus({ ready: true, missing: [] }, run).story?.hlsUrl).toBeNull();
  });
  it('never presents synthetic clips as playable media', () => {
    const run = { state: 'running', fakeClips: true, hlsUrl: 'fake://pickford-clips/example', clips: [{ playedAt: '2026-09-07T13:08:34Z' }] } as unknown as ExternalRendererRunStatus;
    expect(viewerStatus({ ready: true, missing: [] }, run).story?.hlsUrl).toBeNull();
  });
});
