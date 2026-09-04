import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { allowOperatorRequest } from './access.js';
const req = (headers: Record<string, string | undefined>) => ({ headers }) as IncomingMessage;
describe('operator boundary', () => {
  it('allows local CLI and same-origin studio', () => {
    expect(allowOperatorRequest(req({ host: '127.0.0.1:4173' }), '')).toBe(true);
    expect(allowOperatorRequest(req({ host: 'localhost:4173', origin: 'http://localhost:4173' }), '')).toBe(true);
  });
  it('blocks DNS rebinding, cross-origin requests and reverse proxies', () => {
    for (const headers of [{ host: 'evil.example' }, { host: 'localhost:4173', origin: 'https://evil.example' }, { host: 'localhost:4173', 'x-forwarded-for': '1.2.3.4' }, { host: 'localhost:4173', 'sec-fetch-site': 'cross-site' }]) {
      expect(allowOperatorRequest(req(headers as Record<string, string | undefined>), '')).toBe(false);
    }
  });
  it('requires the secret on a hosted worker even over a private proxy', () => {
    expect(allowOperatorRequest(req({ host: 'localhost:4175' }), 'test-secret')).toBe(false);
    expect(allowOperatorRequest(req({ host: 'localhost:4175', authorization: 'Bearer wrong' }), 'test-secret')).toBe(false);
    expect(allowOperatorRequest(req({ host: 'localhost:4175', authorization: 'Bearer test-secret' }), 'test-secret')).toBe(true);
  });
});
