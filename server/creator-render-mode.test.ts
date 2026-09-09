import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreatorApi } from './creator-api.js';
import { parseExternalRendererRunConfig, type ExternalRendererRunManager, type ExternalRendererRunStatus } from './external-renderer.js';
import type { PickfordAuth } from './pickford-auth.js';
import { writeStoredCredential } from './renderer-credential.js';

const EVD_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const RENDERER_ID = 'bbbbbbbb-0000-4000-8000-000000000001';

describe('CreatorApi rendering mode', () => {
  let directory: string | null = null;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it('starts MiniMax StoryBundles through the scheduled Max reference-to-video pipeline', async () => {
    directory = mkdtempSync(join(tmpdir(), 'renderer-creator-mode-'));
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

    const start = vi.fn((_config: unknown) => ({ runId: 'cccccccc-0000-4000-8000-000000000001' }) as ExternalRendererRunStatus);
    const runs = { latest: () => null, start } as unknown as ExternalRendererRunManager;
    const auth = {
      accessToken: async () => 'fixture-private-access-token',
      status: () => ({ signedIn: true }),
      notice: () => null,
    } as unknown as PickfordAuth;
    const api = new CreatorApi(runs, { env, auth });

    await (api as unknown as { play(evdId: string): Promise<ExternalRendererRunStatus> }).play(EVD_ID);

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      evdId: EVD_ID,
      rendererConfig: { model: 'fal-max-ref2v' },
    }));
    expect(parseExternalRendererRunConfig(start.mock.calls[0][0])).toMatchObject({
      renderMode: 'fal-max-ref2v',
      continuityStrategy: 'camera-anchors',
      generationConcurrency: 4,
      maxBufferedSeconds: 45,
    });
  });
});
