import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./doctor.mjs', import.meta.url));

describe('doctor model credential checks', () => {
  it.each([
    { model: 'auto', workerFal: false, workerMinimax: true, localFal: false, expected: true },
    { model: 'fal-max-ref2v', workerFal: false, workerMinimax: true, localFal: true, expected: false },
    { model: 'fal-turbo-i2v', workerFal: true, workerMinimax: false, localFal: false, expected: true },
  ])('uses worker capabilities for $model', async ({ model, workerFal, workerMinimax, localFal, expected }) => {
    const root = await mkdtemp(join(tmpdir(), 'renderer-doctor-'));
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ falKeyConfigured: workerFal, minimaxKeyConfigured: workerMinimax }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = String(server.address().port);
    const origin = `http://127.0.0.1:${port}`;
    const path = join(root, 'handoff.json');
    const ffmpeg = join(root, 'ffmpeg-fixture');
    const handoff = { evdId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', rendererId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', setupToken: 'fixture-private-setup', clientSecret: 'fixture-private-installation', rendererConfig: { model }, initialImageUrl: 'https://images.example/scene.jpg' };
    await writeFile(path, JSON.stringify(handoff));
    await writeFile(ffmpeg, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('STORY_')) delete env[key];
    Object.assign(env, { STORY_HANDOFF_PATH: path, PORT: port, NARRATIVE_ENGINE_URL: origin, RENDERER_PLATFORM_URL: origin, NARRATIVE_AUTHORING_URL: '', REALTIME_GATEWAY_URL: '', CHAT_BACKEND_URL: '', MEDIA_RELAY_HLS_BASE_URL: origin, FFMPEG_PATH: ffmpeg, FAL_KEY: localFal ? 'fixture-private-fal' : '', FAL_API_KEY: '', MINIMAX_API_KEY: '' });
    try {
      const run = async () => {
        const result = await exec(process.execPath, [cli], { cwd: root, env }).catch(error => ({ stdout: error.stdout }));
        expect(result.stdout).not.toContain('fixture-private');
        return JSON.parse(result.stdout);
      };
      const result = await run();
      expect(result.ok).toBe(expected);
      expect(result.checks.find(check => check.name.includes('credential')).ok).toBe(expected);
      expect(result.checks.find(check => check.name === 'agent-managed story access').ok).toBe(true);
      expect(result.checks.find(check => check.name === 'worker')).toMatchObject({ ok: true, check: 'HTTP reachability' });
      if (model === 'auto') {
        await writeFile(path, JSON.stringify({ ...handoff, setupToken: '' }));
        const missingStory = await run();
        expect(missingStory.ok).toBe(false);
        expect(missingStory.checks.find(check => check.name.includes('credential')).ok).toBe(true);
        expect(missingStory.checks.find(check => check.name === 'agent-managed story access').ok).toBe(false);
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
});
