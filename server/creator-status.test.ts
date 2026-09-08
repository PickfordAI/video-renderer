import { describe, expect, it } from 'vitest';

import { creatorStatus, firstClipEtaSeconds, NOMINAL_FIRST_CLIP_SECONDS, playbackStatus } from './creator-status.js';
import { emptyPlaybackGapSummary, type ExternalRendererRunStatus } from './external-renderer.js';

const START = Date.parse('2026-09-07T12:00:00Z');

function run(overrides: Partial<ExternalRendererRunStatus> = {}): ExternalRendererRunStatus {
  return {
    runId: 'aaaaaaaa-0000-4000-8000-000000000001',
    state: 'running',
    rendererId: 'bbbbbbbb-0000-4000-8000-000000000001',
    rendererVersion: 'h3.opensource.v1.1',
    startMode: 'opaque',
    storyRunId: 'cccccccc-0000-4000-8000-000000000001',
    audienceJoinUrl: 'https://dev.pickford.ai/join/abc',
    storyId: 4242,
    roomId: '', roomShortlink: '', storyMessageChannelId: '', roomMainMessageChannelId: '',
    sessionId: null, sessionEpoch: null,
    startedAt: new Date(START).toISOString(),
    storyStartAt: new Date(START).toISOString(),
    storyStartStatus: 202,
    storyEndedAt: null, firstAssignmentAt: null, firstDssAcknowledgedAt: null,
    dssSequences: [], dssCommandsRendered: 0, clipsRendered: 0, clips: [],
    anchorsEstablished: 0, anchorsReused: 0, generationMsPercentiles: null,
    playbackGaps: emptyPlaybackGapSummary(),
    mediaDir: null, finalMp4: null, hlsUrl: 'http://127.0.0.1:4174/hls/h3-x/index.m3u8',
    lastHeartbeatAt: null,
    eventVerdicts: {} as ExternalRendererRunStatus['eventVerdicts'],
    failures: [],
    ...overrides,
  };
}

function clip(playedAt: string | null) {
  return { playedAt } as ExternalRendererRunStatus['clips'][number];
}

describe('first clip ETA', () => {
  it('counts down from a nominal budget before any clip has played', () => {
    expect(firstClipEtaSeconds(run(), START)).toBe(NOMINAL_FIRST_CLIP_SECONDS);
    expect(firstClipEtaSeconds(run(), START + 60_000)).toBe(NOMINAL_FIRST_CLIP_SECONDS - 60);
  });

  it('never goes negative', () => {
    expect(firstClipEtaSeconds(run(), START + 10 * 60_000)).toBe(0);
  });

  it('uses a measured generation time once one exists', () => {
    const measured = run({ generationMsPercentiles: { min: 50_000, median: 60_000, max: 90_000 } });
    expect(firstClipEtaSeconds(measured, START)).toBe(90);
  });

  it('stops estimating once a clip has played or the run is over', () => {
    expect(firstClipEtaSeconds(run({ clips: [clip('2026-09-07T12:03:00Z')] }), START)).toBeNull();
    expect(firstClipEtaSeconds(run({ state: 'ended' }), START)).toBeNull();
    expect(firstClipEtaSeconds(null, START)).toBeNull();
  });
});

describe('playback status', () => {
  it('withholds the manifest until a real clip has played', () => {
    expect(playbackStatus(run(), 'evd', START)).toMatchObject({ state: 'preparing', hlsUrl: null });
    expect(playbackStatus(run({ clips: [clip('2026-09-07T12:03:00Z')] }), 'evd', START))
      .toMatchObject({ state: 'playing', hlsUrl: 'http://127.0.0.1:4174/hls/h3-x/index.m3u8' });
  });

  it('distinguishes starting from preparing and reports terminal states', () => {
    expect(playbackStatus(run({ storyStartStatus: null }), null, START).state).toBe('starting');
    expect(playbackStatus(run({ state: 'failed' }), null, START).state).toBe('failed');
    expect(playbackStatus(run({ state: 'stopped' }), null, START).state).toBe('stopped');
    expect(playbackStatus(null, null, START).state).toBe('idle');
  });

  it('reports the backend refusal that stopped a run', () => {
    const refused = run({ state: 'failed', failures: ['renderer story start failed with HTTP 409: This StoryBundle is still preparing images.'] });
    expect(playbackStatus(refused, 'evd', START).error)
      .toBe('renderer story start failed with HTTP 409: This StoryBundle is still preparing images.');
    expect(playbackStatus(run({ state: 'failed', failures: [] }), 'evd', START).error).toBe('This StoryBundle stopped unexpectedly.');
    expect(playbackStatus(run(), 'evd', START).error).toBeNull();
  });

  it('carries the opaque start identities the creator needs', () => {
    expect(playbackStatus(run(), 'evd-1', START)).toMatchObject({
      storyRunId: 'cccccccc-0000-4000-8000-000000000001',
      storyId: 4242,
      audienceJoinUrl: 'https://dev.pickford.ai/join/abc',
      evdId: 'evd-1',
    });
  });
});

describe('creator status', () => {
  const credential = {
    environment: 'dev', rendererId: 'bbbbbbbb-0000-4000-8000-000000000001', credentialId: 'bbbbbbbb-0000-4000-8000-000000000002',
    clientSecret: 'secret-1', installationName: 'Local video renderer', adapter: 'bearer' as const,
    createdAt: '', rotatedAt: null, expiresAt: null,
  };

  it('flags a fenced credential from an authentication failure on the run', () => {
    const status = creatorStatus({
      environment: 'dev',
      auth: { signedIn: true, environment: 'dev', email: 'creator@example.com', role: 'creator', scope: 'storykernel:renderer', expiresAt: null },
      credential,
      falKey: { present: true, source: 'local-config' },
      bundleAdapter: 'story-bundles',
      run: run({ state: 'failed', failures: ['renderer bridge closed: 401 unauthorized'] }),
      evdId: 'evd-1', nowMs: START, csrfToken: 'csrf',
    });
    expect(status.credential.fenced).toBe(true);
    expect(JSON.stringify(status)).not.toContain('secret-1');
  });

  it('does not flag an ordinary generation failure as a fence', () => {
    const status = creatorStatus({
      environment: 'dev',
      auth: { signedIn: true, environment: 'dev', email: null, role: null, scope: null, expiresAt: null },
      credential,
      falKey: { present: false, source: null },
      bundleAdapter: null,
      run: run({ state: 'failed', failures: ['fal generation failed'] }),
      evdId: null, nowMs: START, csrfToken: null,
    });
    expect(status.credential.fenced).toBe(false);
  });
});
