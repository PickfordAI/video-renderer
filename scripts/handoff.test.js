import { describe, expect, it } from 'vitest';
import { validateHandoff } from './handoff.mjs';
const valid = () => ({ rendererId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', credentialId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', evdId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', clientSecret: 'test', setupToken: 'test' });
describe('handoff validation before provisioning', () => {
  it('accepts an onboarding handoff', () => expect(validateHandoff(valid())).toEqual(valid()));
  it('rejects credentials, duration and version mistakes before creating a room', () => {
    for (const change of [{ rendererId: 'wrong' }, { clientSecret: '' }, { clipDurationSeconds: 99 }, { rendererVersion: 'v1' }, { environment: 'wrong' }]) expect(() => validateHandoff({ ...valid(), ...change })).toThrow();
  });
  it('rejects local and credential-bearing URLs for hosted workers', () => {
    for (const url of ['http://127.0.0.1:8281', 'https://localhost', 'https://token@example.com', 'https://example.com?token=secret']) expect(() => validateHandoff({ ...valid(), services: { narrativeEngineUrl: url } }, true)).toThrow();
  });
});
