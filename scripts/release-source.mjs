import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version');
const name = `pickford-video-renderer-${pkg.version}`;
const releases = resolve('.renderer/releases');
const destination = join(releases, name);
// A fixed source allowlist deliberately excludes git history, local state and generated files.
const entries = ['.github', '.dockerignore', '.env.example', '.gitignore', '.nvmrc', '.vercelignore',
  'AGENTS.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
  'Dockerfile', 'docker-compose.yml', 'fly.toml', 'render.yaml', 'vercel.json', 'package.json', 'package-lock.json',
  'index.html', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.server.json', 'tsconfig.server.build.json',
  'vite.config.ts', 'vitest.config.ts', 'docs', 'deploy', 'examples', 'media-relay', 'public', 'scripts', 'server', 'src', 'viewer'];
mkdirSync(releases, { recursive: true });
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination);
for (const entry of entries) cpSync(entry, join(destination, entry), { recursive: true, filter: source => {
  const name = basename(source);
  return !name.endsWith('.log') && !name.endsWith('.local') && name !== '.DS_Store';
} });
function check(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release contains a symlink: ${entry.name}`);
    if (entry.isDirectory()) check(path);
    else if (/^(?:\.env(?!\.example$)|.*handoff\.json$)/.test(entry.name)) throw new Error('Release contains a local credential file.');
  }
}
check(destination);
const archive = join(releases, `${name}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', releases, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
console.log(JSON.stringify({ archive, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), note: 'Source snapshot only; no Git history or dependencies. Review contents before publishing.' }, null, 2));
