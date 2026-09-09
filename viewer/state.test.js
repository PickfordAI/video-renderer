import { describe, expect, it, vi } from 'vitest';
import { audienceDisplayLabel, audienceDisplayName, audienceMessageInput, audienceReceiptMessage, fitTextareaToContent, handleAudienceMessageKeydown, shouldSubmitAudienceMessage, setupMessage, validStreamUrl } from './state.js';
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

describe('audienceDisplayName', () => {
  it('uses the signed-in creator email without asking for another name', () => {
    expect(audienceDisplayName({ auth: { signedIn: true, email: ' creator@example.com ' } })).toBe('creator@example.com');
  });

  it('uses a neutral name when the public viewer has no account identity', () => {
    expect(audienceDisplayName(null)).toBe('Audience');
    expect(audienceDisplayName({ auth: { signedIn: false, email: 'stale@example.com' } })).toBe('Audience');
  });
});

describe('audienceDisplayLabel', () => {
  it('shows only the local part of an email while leaving non-email names intact', () => {
    expect(audienceDisplayLabel('creator@example.com')).toBe('creator');
    expect(audienceDisplayLabel('Audience')).toBe('Audience');
  });
});

describe('shouldSubmitAudienceMessage', () => {
  it('submits on Enter without inserting a newline', () => {
    expect(shouldSubmitAudienceMessage({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
  });

  it('keeps Shift+Enter for newlines and ignores IME confirmation', () => {
    expect(shouldSubmitAudienceMessage({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
    expect(shouldSubmitAudienceMessage({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitAudienceMessage({ key: 'a', shiftKey: false, isComposing: false })).toBe(false);
  });
});

describe('handleAudienceMessageKeydown', () => {
  it('prevents a newline and submits the form for plain Enter', () => {
    const event = { key: 'Enter', shiftKey: false, isComposing: false, preventDefault: vi.fn() };
    const submit = vi.fn();

    expect(handleAudienceMessageKeydown(event, { submitting: false, submit })).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });

  it('allows Shift+Enter to create a newline', () => {
    const event = { key: 'Enter', shiftKey: true, isComposing: false, preventDefault: vi.fn() };
    const submit = vi.fn();

    expect(handleAudienceMessageKeydown(event, { submitting: false, submit })).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('prevents another newline without resubmitting while a send is in progress', () => {
    const event = { key: 'Enter', shiftKey: false, isComposing: false, preventDefault: vi.fn() };
    const submit = vi.fn();

    expect(handleAudienceMessageKeydown(event, { submitting: true, submit })).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });
});
