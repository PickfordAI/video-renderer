import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { option, readState, stateDir, writePrivate } from './config.mjs';
try {
  const app = option('app');
  if (!app || !/^[a-z][a-z0-9-]{2,62}$/.test(app)) throw new Error('Pass --app <unique-fly-app-name>. Create it in your Fly account first (fly apps create).');
  const falKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falKey || /[\r\n]/.test(falKey)) throw new Error('Set FAL_KEY in the environment or local .env.');
  const previous = readState('hosted.json');
  const adminToken = previous?.app === app ? previous.adminToken : randomBytes(32).toString('hex');
  // Secrets enter through stdin, never through shell expansion or process arguments.
  execFileSync('fly', ['secrets', 'import', '--stage', '--app', app], {
    input: `FAL_KEY=${falKey}\nRENDERER_ADMIN_TOKEN=${adminToken}\n`, stdio: ['pipe', 'ignore', 'ignore'],
  });
  writePrivate(resolve(stateDir, 'hosted.json'), { provider: 'fly', app, publicOrigin: `https://${app}.fly.dev`, adminToken });
  execFileSync('fly', ['deploy', '--app', app, '--ha=false', '--remote-only'], { stdio: 'inherit' });
  console.log(JSON.stringify({ provider: 'fly', app, publicOrigin: `https://${app}.fly.dev`, next: 'npm run hosted:connect' }));
} catch { console.error('Worker deployment failed. Check the Fly CLI login, app ownership, and FAL_KEY; then retry. Saved secrets are in .renderer/hosted.json.'); process.exitCode = 1; }
