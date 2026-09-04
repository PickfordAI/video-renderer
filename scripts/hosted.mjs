import { spawn } from 'node:child_process';
if (!process.env.RENDERER_ADMIN_TOKEN) throw new Error('Hosted workers require RENDERER_ADMIN_TOKEN.');
// Render's PORT designates the public listener. Keep operator HTTP on its private port.
if (process.env.RENDER) {
  process.env.MEDIA_PORT ||= process.env.PORT || '4174';
  process.env.PORT = '4173';
}
process.env.MEDIA_HOST ||= '0.0.0.0';
const children = [
  spawn('/usr/local/bin/mediamtx', ['/app/media-relay/mediamtx.yml'], { stdio: 'inherit' }),
  spawn(process.execPath, ['server-dist/index.js'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 10_000).unref();
}
for (const child of children) { child.once('error', () => stop(1)); child.once('exit', code => stop(code || 0)); }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop());
