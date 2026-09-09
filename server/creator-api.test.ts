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
    fakeClips: false,
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
    vi.unstubAllGlobals();
  });

  it('starts the audience exchange against the environment chat backend', async () => {
    directory = mkdtempSync(join(tmpdir(), 'renderer-creator-api-'));
    const env: NodeJS.ProcessEnv = {
      RENDERER_STATE_DIR: join(directory, '.renderer'),
      FAL_KEY: 'fixture-private-fal-key',
    };
    writeStoredCredential({
      environment: 'prod',
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
      baseUrl: 'https://pickford.ai',
      audienceExchangeUrl: 'https://chat.pickford.ai/api/v1/external-audience/exchange',
      rendererVersion: 'h3.opensource.v1.2',
      supersedeExistingStory: true,
    }));
  });

  it('mints a credential instead of reusing one from another environment', async () => {
    directory = mkdtempSync(join(tmpdir(), 'renderer-creator-api-'));
    const env: NodeJS.ProcessEnv = {
      RENDERER_STATE_DIR: join(directory, '.renderer'),
      STORY_ENVIRONMENT: 'prod',
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
    const prodRendererId = 'eeeeeeee-0000-4000-8000-000000000001';
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      credential: {
        renderer_id: prodRendererId,
        credential_id: 'ffffffff-0000-4000-8000-000000000001',
        installation_name: 'Fixture renderer',
        created_at: new Date(0).toISOString(),
      },
      client_secret: 'fixture-private-prod-secret',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchImpl);

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

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://pickford.ai/bff/v1/developer/renderers');
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ rendererId: prodRendererId }));
  });

  it('cancels the exact Pickford story before stopping the same local renderer run', async () => {
    const active = { ...run(), state: 'running' as const, storyId: 77, roomShortlink: 'night shift/1' };
    const stopActive = vi.fn(async () => ({ ...active, state: 'stopped' as const }));
    const runs = {
      latest: () => active,
      active: () => active,
      stopActive,
    } as unknown as ExternalRendererRunManager;
    const auth = {
      accessToken: async () => 'fixture-private-access-token',
      status: () => ({ signedIn: true }),
      notice: () => null,
    } as unknown as PickfordAuth;
    const fetchImpl = vi.fn(async () => Response.json({ message: 'Story job cancelled; aborted script' }));
    vi.stubGlobal('fetch', fetchImpl);
    const api = new CreatorApi(runs, { auth });

    await expect((api as unknown as { stop(): Promise<ExternalRendererRunStatus> }).stop())
      .resolves.toMatchObject({ state: 'stopped' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.pickford.ai/story/cancel?room_shortlink=night%20shift%2F1',
      { method: 'POST', headers: { Authorization: 'Bearer fixture-private-access-token' } },
    );
    expect(stopActive).toHaveBeenCalledWith(active.runId);
  });

  it('keeps the local run active when Pickford rejects cancellation so Stop can be retried', async () => {
    const active = { ...run(), state: 'running' as const, storyId: 77, roomShortlink: 'night-shift-1' };
    const stopActive = vi.fn();
    const runs = {
      latest: () => active,
      active: () => active,
      stopActive,
    } as unknown as ExternalRendererRunManager;
    const auth = {
      accessToken: async () => 'fixture-private-access-token',
      status: () => ({ signedIn: true }),
      notice: () => null,
    } as unknown as PickfordAuth;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ detail: 'Failed to cancel story' }, { status: 500 })));
    const api = new CreatorApi(runs, { auth });

    await expect((api as unknown as { stop(): Promise<ExternalRendererRunStatus> }).stop())
      .rejects.toThrow('Pickford could not stop your StoryBundle (HTTP 500).');
    expect(stopActive).not.toHaveBeenCalled();
  });

  it('stops the local run when Pickford says the story is already inactive', async () => {
    const active = { ...run(), state: 'failed' as const, storyId: 77, roomShortlink: 'night-shift-1' };
    const stopActive = vi.fn(async () => ({ ...active, state: 'stopped' as const }));
    const runs = {
      latest: () => active,
      active: () => active,
      stopActive,
    } as unknown as ExternalRendererRunManager;
    const auth = {
      accessToken: async () => 'fixture-private-access-token',
      status: () => ({ signedIn: true }),
      notice: () => null,
    } as unknown as PickfordAuth;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ detail: 'No active story found' }, { status: 400 })));
    const api = new CreatorApi(runs, { auth });

    await expect((api as unknown as { stop(): Promise<ExternalRendererRunStatus> }).stop())
      .resolves.toMatchObject({ state: 'stopped' });
    expect(stopActive).toHaveBeenCalledWith(active.runId);
  });
});
