import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostingConfig } from './hosting-config.mjs';
import { option, readState, stateDir, writePrivate } from './config.mjs';
try {
  const config = hostingConfig({ provider: option('provider'), name: option('name'), origin: option('origin'), sshTarget: option('ssh') }, readState('hosted.json') ?? {});
  const falKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falKey || /[\r\n\0]/.test(falKey)) throw new Error('Provide FAL_KEY through the environment or .env.');
  config.adminToken ||= randomBytes(32).toString('hex');
  writePrivate(resolve(stateDir, 'hosted.json'), config);
  const secrets = { FAL_KEY: falKey, RENDERER_ADMIN_TOKEN: config.adminToken };
  if (config.provider === 'vm') secrets.RENDERER_DOMAIN = new URL(config.publicOrigin).hostname;
  // JSON is suitable for connector/API calls. Compose gets a literal single-quoted env file.
  writePrivate(resolve(stateDir, 'hosting-secrets.json'), secrets);
  const envFile = resolve(stateDir, 'hosting.env');
  writeFileSync(envFile, Object.entries(secrets).map(([key, value]) => `${key}='${value.replaceAll("'", "\\'")}'`).join('\n') + '\n', { mode: 0o600 });
  chmodSync(envFile, 0o600);
  console.log(JSON.stringify({ provider: config.provider, name: config.name, publicOrigin: config.publicOrigin, secretsFile: resolve(stateDir, 'hosting-secrets.json'), composeEnvFile: envFile, next: 'Apply these secrets to the chosen host without printing them. See docs/deployment.md.' }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
