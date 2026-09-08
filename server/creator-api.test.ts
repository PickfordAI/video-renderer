import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreatorApi } from './creator-api.js';
import { emptyPlaybackGapSummary, type ExternalRendererRunManager, type ExternalRendererRunStatus } from './external-renderer.js';
import type { PickfordAuth } from './pickford-auth.js';
import { writeStoredCredential } from './renderer-credential.js';

const EVD_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const RENDERER_ID = 'bbbbbbbb-0000-4000-8000-000000000001';

function run(): ExternalRendererRunStatus {
  return {
    runId: 'cccccccc-0000-4000-8000-000000000001',
    state: 'connecting',
    rendererId: RENDERER_ID,
    rendererVersion: 'h3.opensource.v1.1',
    startMode: 'opaque',
    storyRunId: null,
    audienceJoinUrl: null,
    storyId: null,
    roomId: '', roomShortlink: '', storyMessageChannelId: '', roomMainMessageChannelId: '',
    sessionId: null, sessionEpoch: null,
    startedAt: new Date(0).toISOString(), storyStartAt: null, storyStartStatus: null,
    storyEndedAt: null, firstAssignmentAt: null, firstDssAcknowledgedAt: null,
    dssSequences: [], dssCommandsRendered: 0, clipsRendered: 0, clips: [],
    anchorsEstablished: 0, anchorsReused: 0, generationMsPercentiles: null,
    playbackGaps: emptyPlaybackGapSummary(),
    mediaDir: null, finalMp4: null, hlsUrl: null, lastHeartbeatAt: null,
    eventVerdicts: {} as ExternalRendererRunStatus['eventVerdicts'],
    failures: [],
  };
}

describe('CreatorApi playback routing', () => {
  let directory: string | null = null;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it('starts the audience exchange against the environment chat backend', async () => {
    directory = mkdtempSync(join(tmpdir(), 'renderer-creator-api-'));
    const env: NodeJS.ProcessEnv = {
      RENDERER_STATE_DIR: join(directory, '.renderer'),
      STORY_ENVIRONMENT: 'dev',
      FAL_KEY: 'fixture-private-fal-key',
    };
    writeStoredCredential({
      environment: 'dev',
      rendererId: RENDERER_ID,
      credentialId: 'dddddddd-0000-4000-8000-000000000001',
      clientSecret: 'fixture-private-client-secret',
      installationName: 'Fixture renderer',
      adapter: 'bearer',
      createdAt: new Date(0).toISOString(),
      rotatedAt: null,
      expiresAt: null,
    }, env);

    const start = vi.fn(() => run());
    const runs = {
      latest: () => null,
      start,
    } as unknown as ExternalRendererRunManager;
    const auth = {
      accessToken: async () => 'fixture-private-access-token',
      status: () => ({ signedIn: true }),
      notice: () => null,
    } as unknown as PickfordAuth;
    const api = new CreatorApi(runs, { env, auth });

    await (api as unknown as { play(evdId: string): Promise<ExternalRendererRunStatus> }).play(EVD_ID);

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://dev.pickford.ai',
      audienceExchangeUrl: 'https://chat.dev.pickford.ai/api/v1/external-audience/exchange',
      rendererVersion: 'h3.opensource.v1.2',
    }));
  });
});
