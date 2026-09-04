import { spawn } from 'node:child_process';
import { connectionCommand } from './hosting-config.mjs';
import { readState } from './config.mjs';
try {
  const config = readState('hosted.json');
  if (!config) throw new Error('Deploy with npm run deploy:fly or run npm run hosted:prepare first.');
  const { command, args } = connectionCommand(config);
  const child = spawn(command, args, { stdio: 'inherit' });
  child.once('error', () => { console.error(`Could not run ${command}. Install/login to the selected provider's tooling.`); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
} catch (error) { console.error(error.message); process.exitCode = 1; }
