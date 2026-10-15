import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('signs in by device, exchanges a renderer grant, and keeps tokens in a private file', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'renderer-device-test-'));
  const rendererId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let polls = 0;
  const http = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw);
    requests.push({ path: request.url!, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/auth/device/authorize') response.end(JSON.stringify({ device_code: 'fixture-private-device', user_code: 'VISIBLE-CODE', verification_uri: 'https://pickford.example/v1/auth/page/device', expires_in: 60, interval: 0.001 }));
    else if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      polls += 1;
      if (polls === 1) { response.statusCode = 400; response.end(JSON.stringify({ code: 'authorization_pending', retry_after_seconds: 0 })); }
      else response.end(JSON.stringify({ access_token: 'fixture-private-user' }));
    } else {
      expect(body).toMatchObject({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: 'fixture-private-user', renderer_name: 'fixture-renderer', renderer_kind: 'generative_video' });
      response.end(JSON.stringify({ access_token: 'fixture-private-renderer', refresh_token: 'fixture-private-refresh', scope: 'renderer.connect', expires_in: 900, renderer: { renderer_id: rendererId, session_generation: 1, bridge_url: 'wss://pickford.example/v1/renderers/bridge' } }));
    }
  });
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  try {
    const port = (http.address() as { port: number }).port;
    const entry = fileURLToPath(new URL('./renderer-device-cli.ts', import.meta.url));
    const loader = resolve('node_modules/tsx/dist/loader.mjs');
    const child = spawn(process.execPath, ['--import', loader, entry, 'fixture-renderer'], { cwd: directory, env: { ...process.env, PICKFORD_API_URL: `http://127.0.0.1:${port}` } });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const exit = await new Promise<number | null>(done => child.on('exit', done));
    expect(exit, output).toBe(0);
    expect(output).toContain('VISIBLE-CODE');
    expect(output).not.toContain('fixture-private-');
    const credentials = resolve(directory, '.renderer/v1-renderer.json');
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentials, 'utf8'))).toMatchObject({ startMode: 'v1', rendererId, rendererAccessToken: 'fixture-private-renderer', rendererRefreshToken: 'fixture-private-refresh' });
    expect(polls).toBe(2);
    expect(requests.every(request => request.path.startsWith('/v1/'))).toBe(true);
  } finally {
    await new Promise<void>(done => http.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
