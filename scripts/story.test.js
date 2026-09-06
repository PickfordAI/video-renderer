import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./story.mjs', import.meta.url));
const story = { storyId: 42, roomId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', roomShortlink: 'STORY', storyMessageChannelId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', roomMainMessageChannelId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
const runId = '12345678-1234-4234-8234-123456789abc';
describe('agent story lifecycle', () => {
  it.each([
    { source: 'explicit-file', renderMode: 'auto', storyType: undefined },
    { source: 'registered-file', renderMode: 'fal-turbo-i2v', storyType: 'WHISPERS' },
    { source: 'env-file', renderMode: 'fal-max-ref2v', storyType: 'MINIMAX' },
    { source: 'environment', renderMode: 'canonical-max-independent', storyType: 'MINIMAX' },
    { source: 'explicit-file', renderMode: 'fal-max-ref2v', storyType: 'MINIMAX', streamedRefs: true },
  ])('starts and stops through $source configuration with $renderMode', async ({ source, renderMode, storyType, streamedRefs }) => {
    const root = await mkdtemp(join(tmpdir(), 'renderer-cli-'));
    const calls = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      calls.push({ path: req.url, method: req.method, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/health') res.end(JSON.stringify({ falKeyConfigured: true }));
      else if (req.url.includes('provision')) res.end(JSON.stringify(story));
      else if (req.url === '/api/external-renderer/runs') res.end(JSON.stringify({ runId, state: 'connecting', hlsUrl: null }));
      else res.end(JSON.stringify({ runId, state: 'running', hlsUrl: `http://127.0.0.1:4174/hls/h3-${runId}/index.m3u8` }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const expectedConfig = renderMode === 'canonical-max-independent' ? { model: 'fal-max-ref2v', continuity: 'none', concurrency: 4, maxBufferedSeconds: 35 } : { model: renderMode, continuity: renderMode === 'fal-turbo-i2v' ? 'last-frame-chain' : renderMode === 'fal-max-ref2v' ? 'camera-anchors' : 'none', concurrency: 3, maxBufferedSeconds: 25 };
    const handoff = { storyType, ...(renderMode === 'canonical-max-independent' ? { rendererConfig: expectedConfig } : { renderMode }), initialImageUrl: 'https://images.example/scene.jpg', generationConcurrency: 3, maxBufferedSeconds: 25, shotPlanner: { styleDescription: 'Noir', characters: {} }, evdId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', rendererId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', setupToken: 'private-setup', clientSecret: 'private-installation', services: { narrativeEngineUrl: 'https://show.example', rendererBaseUrl: 'https://renderer.example' } };
    if (streamedRefs) { delete handoff.initialImageUrl; delete handoff.shotPlanner; }
    const path = join(root, 'handoff.json');
    await writeFile(path, JSON.stringify(handoff));
    const options = { cwd: root, env: { ...process.env, PORT: String(port) } };
    for (const key of Object.keys(options.env)) if (key.startsWith('STORY_')) delete options.env[key];
    const flags = source === 'explicit-file' ? ['--handoff', path] : [];
    if (source === 'env-file') options.env.STORY_HANDOFF_PATH = path;
    if (source === 'environment') Object.assign(options.env, {
      STORY_EVD_ID: handoff.evdId, STORY_RENDERER_ID: handoff.rendererId,
      STORY_CREDENTIAL_ID: handoff.credentialId, STORY_CLIENT_SECRET: handoff.clientSecret,
      ...(storyType ? { STORY_TYPE: storyType } : {}),
      STORY_SETUP_TOKEN: handoff.setupToken, NARRATIVE_ENGINE_URL: handoff.services.narrativeEngineUrl,
      RENDERER_PLATFORM_URL: handoff.services.rendererBaseUrl,
      STORY_RENDERER_CONFIG_JSON: JSON.stringify(expectedConfig),
      STORY_SHOT_PLANNER_JSON: JSON.stringify(handoff.shotPlanner),
      STORY_INITIAL_IMAGE_URL: handoff.initialImageUrl,
    });
    try {
      if (source === 'registered-file') {
        const setup = fileURLToPath(new URL('./setup.mjs', import.meta.url));
        const prepared = await exec(process.execPath, [setup, '--handoff', path], options);
        expect(prepared.stdout).not.toContain(handoff.clientSecret);
        const registered = await readFile(join(root, '.renderer/onboarding.json'), 'utf8');
        expect(JSON.parse(registered)).toEqual({ handoffPath: path });
      }
      const { stdout } = await exec(process.execPath, [cli, 'start', ...flags], options);
      const result = JSON.parse(stdout);
      expect(result.watchUrl).toContain('http://127.0.0.1:4174/#http');
      expect(decodeURIComponent(new URL(result.watchUrl).hash.slice(1))).toContain('/hls/h3-');
      const saved = await readFile(join(root, '.renderer/session.json'), 'utf8');
      expect(saved + stdout).not.toContain('private-');
      expect(JSON.parse(saved)).toMatchObject({ showBaseUrl: handoff.services.narrativeEngineUrl, workerStopped: false, kernelStopped: false });
      const run = calls.find(c => c.path === '/api/external-renderer/runs').body;
      expect(run.storyConfig.base_structure).toBe(storyType ?? 'CREATOR');
      expect(calls.find(c => c.path === '/api/narrative/provision-external-story').body.storyType).toBe(storyType ?? 'CREATOR');
      expect(run.storyConfig.evd_id).toBe(handoff.evdId);
      expect(run.storyConfig.message_channel_ids).toEqual([story.storyMessageChannelId]);
      expect(run).not.toHaveProperty('setupToken');
      expect(run.rendererConfig).toEqual(expectedConfig);
      expect(run.initialImageUrl).toBe(handoff.initialImageUrl);
      expect(run.shotPlanner).toEqual(handoff.shotPlanner);
      expect(run).not.toHaveProperty('renderMode');
      expect(run).not.toHaveProperty('generationConcurrency');
      await exec(process.execPath, [cli, 'stop', ...flags], options);
      expect(calls.some(c => c.method === 'DELETE' && c.path.endsWith(runId))).toBe(true);
      expect(calls.at(-1)).toMatchObject({ path: '/api/narrative/stop-show', body: { token: handoff.setupToken, shortlink: story.roomShortlink } });
      expect(JSON.parse(await readFile(join(root, '.renderer/session.json'), 'utf8'))).toMatchObject({ workerStopped: true, kernelStopped: true });
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('explicit fal preflight', () => {
  it('does not provision a story using only a direct MiniMax key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'renderer-cli-preflight-'));
    const calls = [];
    const server = createServer((req, res) => {
      calls.push(req.url);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ minimaxKeyConfigured: true, falKeyConfigured: false }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const path = join(root, 'handoff.json');
    await writeFile(path, JSON.stringify({ renderMode: 'fal-turbo-i2v', initialImageUrl: 'https://images.example/scene.jpg', evdId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', rendererId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', setupToken: 'fixture', clientSecret: 'fixture', services: { narrativeEngineUrl: 'https://show.example', rendererBaseUrl: 'https://renderer.example' } }));
    try {
      await expect(exec(process.execPath, [cli, 'start', '--handoff', path], { cwd: root, env: { ...process.env, PORT: String(server.address().port) } })).rejects.toMatchObject({ stderr: expect.stringContaining('requires FAL_KEY') });
      expect(calls).toEqual(['/api/health']);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('persistent stop recovery', () => {
  it('stops the kernel despite a worker failure and retries only incomplete cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'renderer-cli-recovery-'));
    const calls = [];
    let deleteAttempts = 0;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      calls.push({ method: req.method, path: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'DELETE' && ++deleteAttempts === 1) { res.statusCode = 503; res.end(JSON.stringify({ error: 'fixture unavailable' })); }
      else if (req.url === '/api/health') res.end(JSON.stringify({ falKeyConfigured: true }));
      else if (req.method === 'GET') { res.statusCode = 404; res.end(JSON.stringify({ error: 'fixture run missing' })); }
      else res.end(JSON.stringify({ stopped: true }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const path = join(root, 'handoff.json');
    const sessionPath = join(root, '.renderer/session.json');
    const handoff = { evdId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', rendererId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', setupToken: 'private-setup', clientSecret: 'private-installation', services: { narrativeEngineUrl: 'https://new-show.example', rendererBaseUrl: 'https://renderer.example' } };
    await writeFile(path, JSON.stringify(handoff));
    await mkdir(join(root, '.renderer'));
    await writeFile(sessionPath, JSON.stringify({ ...story, runId, showBaseUrl: 'https://original-show.example', workerStopped: false, kernelStopped: false, hlsUrl: 'https://viewer.example/hls/one/index.m3u8', watchUrl: 'https://viewer.example/#fixture' }));
    const options = { cwd: root, env: { ...process.env, PORT: String(server.address().port) } };
    try {
      await expect(exec(process.execPath, [cli, 'stop', '--handoff', path], options)).rejects.toMatchObject({ stderr: expect.stringContaining('Cleanup incomplete (worker)') });
      const partial = JSON.parse(await readFile(sessionPath, 'utf8'));
      expect(partial).toMatchObject({ workerStopped: false, kernelStopped: true, runId });
      expect(partial).not.toHaveProperty('watchUrl');
      expect(calls.find(call => call.path === '/api/narrative/stop-show').body).toMatchObject({ baseUrl: 'https://original-show.example', token: handoff.setupToken });
      await expect(exec(process.execPath, [cli, 'start', '--handoff', path], options)).rejects.toMatchObject({ stderr: expect.stringContaining('previous story still needs cleanup') });
      expect(calls.some(call => call.path.includes('provision'))).toBe(false);
      await exec(process.execPath, [cli, 'stop', '--handoff', path], options);
      expect(JSON.parse(await readFile(sessionPath, 'utf8'))).toMatchObject({ workerStopped: true, kernelStopped: true });
      expect(calls.filter(call => call.path === '/api/narrative/stop-show')).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
});
