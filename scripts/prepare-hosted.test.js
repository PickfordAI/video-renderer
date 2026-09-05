import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./prepare-hosted.mjs', import.meta.url));

describe('hosted credential preparation', () => {
  it('keeps credentials private and preserves the operator token when recording the assigned URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'renderer-hosting-'));
    const options = { cwd: root, env: { ...process.env, FAL_KEY: 'test-only-fal-secret' } };
    const args = [cli, '--provider', 'render', '--name', 'story'];
    try {
      const first = await exec(process.execPath, args, options);
      const load = async name => JSON.parse(await readFile(join(root, '.renderer', name), 'utf8'));
      const before = await load('hosted.json');
      expect(before.adminToken).toMatch(/^[a-f0-9]{64}$/);
      const second = await exec(process.execPath, [...args, '--origin', 'https://story.onrender.com', '--ssh', 'srv-story@ssh.ohio.render.com'], options);
      const after = await load('hosted.json');
      expect(after.adminToken).toBe(before.adminToken);
      expect(after.publicOrigin).toBe('https://story.onrender.com');
      expect(await load('hosting-secrets.json')).toEqual({ FAL_KEY: options.env.FAL_KEY, RENDERER_ADMIN_TOKEN: before.adminToken });
      for (const name of ['hosted.json', 'hosting-secrets.json', 'hosting.env']) {
        expect((await stat(join(root, '.renderer', name))).mode & 0o777).toBe(0o600);
      }
      for (const secret of [before.adminToken, options.env.FAL_KEY]) expect(first.stdout + first.stderr + second.stdout + second.stderr).not.toContain(secret);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
