import { describe, expect, it } from 'vitest';
import { audienceMessageInput, audienceReceiptMessage, fitTextareaToContent, setupMessage, validStreamUrl } from './state.js';
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

  it('preserves intentional line breaks in a multiline message', () => {
    expect(audienceMessageInput('Ada', '  First thought\nSecond thought  ')).toEqual({
      displayName: 'Ada',
      content: 'First thought\nSecond thought',
    });
  });

  it('stays quiet for successful delivery while retaining duplicate feedback', () => {
    expect(audienceReceiptMessage({ duplicate: false })).toBe('');
    expect(audienceReceiptMessage({ duplicate: true })).toBe('That message was already received.');
  });
});

describe('fitTextareaToContent', () => {
  it('shrinks or grows the textarea to its current wrapped content height', () => {
    const textarea = { scrollHeight: 72, style: { height: '140px' } };

    fitTextareaToContent(textarea);

    expect(textarea.style.height).toBe('72px');
  });
});
