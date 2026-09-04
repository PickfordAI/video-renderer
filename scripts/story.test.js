import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('provisions, returns a real watch URL, persists no secrets and stops both worker and kernel', async () => {
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
    const handoff = { evdId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', rendererId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', setupToken: 'private-setup', clientSecret: 'private-installation', services: { narrativeEngineUrl: 'https://show.example', rendererBaseUrl: 'https://renderer.example' } };
    const path = join(root, 'handoff.json');
    await writeFile(path, JSON.stringify(handoff));
    const options = { cwd: root, env: { ...process.env, PORT: String(port) } };
    try {
      const { stdout } = await exec(process.execPath, [cli, 'start', '--handoff', path], options);
      const result = JSON.parse(stdout);
      expect(result.watchUrl).toContain('http://127.0.0.1:4174/#http');
      expect(decodeURIComponent(new URL(result.watchUrl).hash.slice(1))).toContain('/hls/h3-');
      const saved = await readFile(join(root, '.renderer/session.json'), 'utf8');
      expect(saved + stdout).not.toContain('private-');
      const run = calls.find(c => c.path === '/api/external-renderer/runs').body;
      expect(run.storyConfig.message_channel_ids).toEqual([story.storyMessageChannelId]);
      expect(run).not.toHaveProperty('setupToken');
      await exec(process.execPath, [cli, 'stop', '--handoff', path], options);
      expect(calls.some(c => c.method === 'DELETE' && c.path.endsWith(runId))).toBe(true);
      expect(calls.at(-1)).toMatchObject({ path: '/api/narrative/stop-show', body: { token: handoff.setupToken, shortlink: story.roomShortlink } });
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
});
