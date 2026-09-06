import { describe, expect, it } from 'vitest';
import { audienceMessageInput, setupMessage, validStreamUrl } from './state.js';
describe('one story player', () => {
  it('explains setup, readiness, startup and terminal states without a credential form', () => {
    expect(setupMessage({ setup: { ready: false } })).toContain('setup left');
    expect(setupMessage({ setup: { ready: true } })).toContain('start your story');
    expect(setupMessage({ setup: { ready: true }, story: { state: 'connecting' } })).toContain('starting');
    for (const state of ['failed', 'stopped']) expect(setupMessage({ setup: { ready: true }, story: { state } })).toContain('stopped');
  });
  it('accepts HTTPS and local HTTP streams but rejects credential URLs and mixed content', () => {
    expect(validStreamUrl('https://story.example/live.m3u8', 'https:')).toContain('https:');
    expect(validStreamUrl('http://localhost:4174/live.m3u8', 'http:')).toContain('localhost');
    for (const url of ['javascript:alert(1)', 'http://public.example/live.m3u8', 'https://user:secret@story.example/live.m3u8', 'http://localhost:4174/live.m3u8']) expect(() => validStreamUrl(url, 'https:')).toThrow();
  });
});

describe('audienceMessageInput', () => {
  it('trims real viewer input and enforces the public message limits', () => {
    expect(audienceMessageInput('  Ada  ', '  Turn left  ')).toEqual({ displayName: 'Ada', content: 'Turn left' });
    expect(() => audienceMessageInput('', 'hello')).toThrow('Add your name');
    expect(() => audienceMessageInput('Ada', ' '.repeat(4))).toThrow('Write a message');
    expect(() => audienceMessageInput('x'.repeat(81), 'hello')).toThrow('80 characters');
    expect(() => audienceMessageInput('Ada', 'x'.repeat(2001))).toThrow('2000 characters');
  });
});
