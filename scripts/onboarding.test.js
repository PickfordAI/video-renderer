import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const exec = promisify(execFile);
const moduleUrl = new URL('./onboarding.mjs', import.meta.url).href;
const setupCli = fileURLToPath(new URL('./setup.mjs', import.meta.url));
const valid = { evdId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', rendererId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', setupToken: 'test-private-setup', clientSecret: 'test-private-installation', services: { narrativeEngineUrl: 'https://show.example', rendererBaseUrl: 'https://renderer.example' } };

describe('agent onboarding readiness', () => {
  it('reports missing, configured, and invalid handoffs without exposing their contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'onboarding-status-'));
    const env = { ...process.env, FAL_KEY: '', FAL_API_KEY: '', MINIMAX_API_KEY: '', NARRATIVE_ENGINE_URL: '', RENDERER_PLATFORM_URL: '' };
    for (const key of Object.keys(env)) if (key.startsWith('STORY_')) delete env[key];
    const status = () => exec(process.execPath, ['--input-type=module', '-e', `import { onboardingStatus } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(onboardingStatus()));`], { cwd: root, env });
    try {
      expect(JSON.parse((await status()).stdout).missing).toEqual(['videoAccount', 'storyAccess', 'storyConnection']);
      const handoff = join(root, 'private.json');
      await writeFile(handoff, JSON.stringify(valid));
      env.FAL_KEY = 'test-private-fal';
      await exec(process.execPath, [setupCli, '--handoff', handoff], { cwd: root, env });
      const ready = await status();
      expect(JSON.parse(ready.stdout)).toEqual({ ready: true, missing: [] });
      expect(ready.stdout).not.toContain('test-private');
      env.FAL_KEY = '';
      env.MINIMAX_API_KEY = 'test-private-minimax';
      expect(JSON.parse((await status()).stdout)).toEqual({ ready: true, missing: [] });
      await writeFile(handoff, JSON.stringify({ ...valid, rendererConfig: { model: 'fal-max-ref2v', continuity: 'none' }, initialImageUrl: 'https://images.example/scene.jpg' }));
      expect(JSON.parse((await status()).stdout)).toEqual({ ready: false, missing: ['videoAccount'] });
      env.FAL_KEY = 'test-private-fal';
      await writeFile(handoff, '{test-private-invalid-json');
      expect(JSON.parse((await status()).stdout).missing).toEqual(['storyAccess']);
      // An explicit bad path must fail closed, not use the previously registered identity.
      env.STORY_HANDOFF_PATH = join(root, 'missing.json');
      expect(JSON.parse((await status()).stdout).ready).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('treats explicit fake clips as the local no-provider smoke path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'onboarding-fake-clips-'));
    const handoff = join(root, 'private.json');
    await writeFile(handoff, JSON.stringify({ ...valid, environment: 'local' }));
    const env = {
      ...process.env,
      STORY_HANDOFF_PATH: handoff,
      PICKFORD_FAKE_CLIPS: '1',
      FAL_KEY: '', FAL_API_KEY: '', MINIMAX_API_KEY: '',
    };
    try {
      const result = await exec(process.execPath, ['--input-type=module', '-e', `import { onboardingStatus } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(onboardingStatus()));`], { cwd: root, env });
      expect(JSON.parse(result.stdout)).toEqual({ ready: true, missing: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('environment generation handoff', () => {
  it('loads model and planner options without mixing a selected file with environment data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'onboarding-render-options-'));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('STORY_')) delete env[key];
    const rendererConfig = { model: 'fal-max-ref2v', continuity: 'camera-anchors', concurrency: 4, maxBufferedSeconds: 40 };
    const shotPlanner = { characters: { Lily: { imageUrl: 'https://images.example/lily.jpg' } }, styleDescription: 'Noir' };
    Object.assign(env, { STORY_EVD_ID: valid.evdId, STORY_RENDERER_CONFIG_JSON: JSON.stringify(rendererConfig), STORY_SHOT_PLANNER_JSON: JSON.stringify(shotPlanner), STORY_INITIAL_IMAGE_URL: 'https://images.example/scene.jpg' });
    const load = () => exec(process.execPath, ['--input-type=module', '-e', `import { loadHandoff } from ${JSON.stringify(moduleUrl)}; const { rendererConfig, shotPlanner, initialImageUrl } = loadHandoff(); console.log(JSON.stringify({ rendererConfig, shotPlanner, initialImageUrl }));`], { cwd: root, env });
    try {
      expect(JSON.parse((await load()).stdout)).toEqual({ rendererConfig, shotPlanner, initialImageUrl: env.STORY_INITIAL_IMAGE_URL });
      env.STORY_RENDERER_CONFIG_JSON = '{invalid-private-fixture';
      await expect(load()).rejects.toMatchObject({ stderr: expect.stringContaining('Agent-managed story JSON is invalid') });
      const path = join(root, 'private.json');
      await writeFile(path, JSON.stringify(valid));
      env.STORY_HANDOFF_PATH = path;
      expect(JSON.parse((await load()).stdout)).toEqual({});
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
