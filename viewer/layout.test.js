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
  });
});
