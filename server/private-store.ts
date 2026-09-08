import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `.renderer/` holds the creator's private local state: OAuth tokens, the self-minted renderer
 * credential, and the fal key. Everything here is 0600 inside a 0700 directory, is never served to
 * a browser, and is never logged. The TypeScript mirror of `scripts/config.mjs`'s `writePrivate`.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.RENDERER_STATE_DIR ?? '.renderer');
}

export function privatePath(name: string, env?: NodeJS.ProcessEnv): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Private state names must be simple file names.');
  return resolve(stateDir(env), name);
}

export function writePrivateJson(name: string, value: unknown, env?: NodeJS.ProcessEnv): void {
  const directory = stateDir(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = privatePath(name, env);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readPrivateJson<T>(name: string, env?: NodeJS.ProcessEnv): T | null {
  const path = privatePath(name, env);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    // A truncated or hand-edited file must not wedge the worker; the creator signs in again.
    return null;
  }
}

export function removePrivateJson(name: string, env?: NodeJS.ProcessEnv): void {
  rmSync(privatePath(name, env), { force: true });
}
