import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearFalKey, falKeyStatus, loadFalKey, saveFalKey, validateFalKey } from './fal-key.js';
import { privatePath } from './private-store.js';

describe('fal key store', () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'renderer-fal-'));
    env = { RENDERER_STATE_DIR: join(directory, '.renderer') };
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('rejects input that is not a plausible key', () => {
    expect(() => validateFalKey('')).toThrow(/Enter your fal key/);
    expect(() => validateFalKey(undefined)).toThrow(/Enter your fal key/);
    expect(() => validateFalKey('short')).toThrow(/does not look like/);
    expect(() => validateFalKey('key with spaces and more')).toThrow(/spaces or line breaks/);
    expect(validateFalKey('  abcdefgh12345678  ')).toBe('abcdefgh12345678');
  });

  it('writes the key 0600 and makes it live without a restart', () => {
    const status = saveFalKey('abcdefgh12345678', env);
    expect(status).toEqual({ present: true, source: 'local-config' });
    expect(env.FAL_KEY).toBe('abcdefgh12345678');
    expect(statSync(privatePath('fal.json', env)).mode & 0o777).toBe(0o600);
  });

  it('reports only presence, never the key', () => {
    saveFalKey('abcdefgh12345678', env);
    expect(JSON.stringify(falKeyStatus(env))).not.toContain('abcdefgh12345678');
  });

  it('loads a stored key at boot but never overrides an explicit environment key', () => {
    saveFalKey('abcdefgh12345678', env);
    const fresh: NodeJS.ProcessEnv = { RENDERER_STATE_DIR: env.RENDERER_STATE_DIR };
    expect(loadFalKey(fresh)).toEqual({ present: true, source: 'local-config' });
    expect(fresh.FAL_KEY).toBe('abcdefgh12345678');

    const configured: NodeJS.ProcessEnv = { RENDERER_STATE_DIR: env.RENDERER_STATE_DIR, FAL_KEY: 'from-environment' };
    expect(loadFalKey(configured)).toEqual({ present: true, source: 'environment' });
    expect(configured.FAL_KEY).toBe('from-environment');
  });

  it('clears the stored key and unsets it in this process', () => {
    saveFalKey('abcdefgh12345678', env);
    expect(clearFalKey(env)).toEqual({ present: false, source: null });
    expect(env.FAL_KEY).toBeUndefined();
  });

  it('leaves an environment-provided key alone when the stored one is cleared', () => {
    const configured: NodeJS.ProcessEnv = { RENDERER_STATE_DIR: env.RENDERER_STATE_DIR, FAL_KEY: 'from-environment' };
    expect(clearFalKey(configured)).toEqual({ present: true, source: 'environment' });
    expect(configured.FAL_KEY).toBe('from-environment');
  });

  it('keeps the key out of everything but its own private file', () => {
    saveFalKey('abcdefgh12345678', env);
    const stored = JSON.parse(readFileSync(privatePath('fal.json', env), 'utf8')) as { key: string };
    expect(stored.key).toBe('abcdefgh12345678');
    expect(Object.keys(stored)).toEqual(['key', 'savedAt']);
  });
});
