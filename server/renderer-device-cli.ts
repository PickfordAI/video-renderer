import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { mintRendererToken, v1AuthRequest } from './v1-renderer-auth.js';

async function main(): Promise<void> {
  const baseUrl = process.env.PICKFORD_API_URL ?? 'https://api.pickford.ai';
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Sign-in requires HTTPS or loopback HTTP');
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid Pickford API URL');
  const clientId = process.env.PICKFORD_DEVICE_CLIENT_ID ?? 'pickford-cli';
  const rendererName = process.argv[2] ?? 'video-renderer';
  const device = await v1AuthRequest(baseUrl, '/v1/auth/device/authorize', { client_id: clientId });
  if (typeof device.device_code !== 'string' || typeof device.user_code !== 'string' || typeof device.verification_uri !== 'string'
      || !Number.isFinite(device.interval) || Number(device.interval) <= 0 || !Number.isFinite(device.expires_in) || Number(device.expires_in) <= 0) throw new Error('Invalid device authorization response');
  console.log(`Open ${device.verification_uri} and enter ${device.user_code}.`);
  let interval = Number(device.interval);
  const expiresAt = Date.now() + Number(device.expires_in) * 1_000;
  let userToken: string | undefined;
  while (Date.now() < expiresAt) {
    await wait(Math.min(interval * 1_000, Math.max(0, expiresAt - Date.now())));
    if (Date.now() >= expiresAt) break;
    try {
      const token = await v1AuthRequest(baseUrl, '/v1/auth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: device.device_code });
      if (typeof token.access_token !== 'string') throw new Error('Device sign-in did not return an access token');
      userToken = token.access_token;
      break;
    } catch (error) {
      const failure = error as Error & { code?: string; retryAfter?: number };
      if (!['authorization_pending', 'slow_down'].includes(failure.code ?? '')) throw error;
      interval = Math.max(failure.code === 'slow_down' ? interval + 5 : interval, failure.retryAfter ?? 0);
    }
  }
  if (!userToken) throw new Error('Device sign-in expired; start again');
  const token = await mintRendererToken(baseUrl, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    subject_token: userToken, renderer_name: rendererName, renderer_kind: 'generative_video',
  });
  const directory = resolve('.renderer');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const output = resolve(directory, 'v1-renderer.json');
  await writeFile(output, JSON.stringify({
    startMode: 'v1', baseUrl, rendererId: token.renderer.renderer_id, clientId,
    rendererAccessToken: token.access_token, rendererRefreshToken: token.refresh_token,
    rendererTokenExpiresIn: token.expires_in, expiresAt: new Date(Date.now() + token.expires_in * 1_000).toISOString(),
    rendererVersion: 'h3.opensource.v1.2',
  }, null, 2) + '\n', { mode: 0o600 });
  await chmod(output, 0o600);
  console.log(JSON.stringify({ rendererId: token.renderer.renderer_id, credentialsFile: output }));
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Device sign-in failed'); process.exitCode = 1; });
