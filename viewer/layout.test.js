import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('player layout', () => {
  it('places the initially hidden audience controls above the initially expanded account', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
    const chat = html.indexOf('<section id="audience-chat" hidden');
    const creator = html.indexOf('<section id="creator" hidden');

    expect(chat).toBeGreaterThan(-1);
    expect(creator).toBeGreaterThan(chat);
    expect(html).toContain('<details id="creator-details" open>');
    expect(html).toContain('<details id="bundles-details" open>');
    expect(html).toContain('<textarea id="chat-message" name="content" rows="1"');
    expect(html).not.toContain('<input id="chat-message"');
    expect(html).not.toContain('id="chat-name"');
    expect(html).not.toContain('Your name');
    expect(html).not.toContain('Send an audience suggestion to the story in progress.');
  });
});
