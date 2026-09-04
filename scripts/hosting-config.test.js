import { describe, expect, it } from 'vitest';
import { connectionCommand, hostingConfig } from './hosting-config.mjs';
import { watchUrlForStream } from './watch-url.mjs';
describe('single-provider hosting', () => {
  it('returns same-host watch links without a viewer setting', () => {
    for (const origin of ['https://story.fly.dev', 'https://story.onrender.com', 'https://stories.example.com', 'http://127.0.0.1:4174']) {
      const stream = `${origin}/hls/h3-session/index.m3u8`;
      const link = new URL(watchUrlForStream(stream));
      expect(link.origin).toBe(origin);
      expect(link.pathname).toBe('/');
      expect(decodeURIComponent(link.hash.slice(1))).toBe(stream);
    }
  });
  it('retains explicit external viewers as an opt-in and rejects unsafe URLs', () => {
    expect(new URL(watchUrlForStream('https://story.fly.dev/hls/test/index.m3u8', 'https://viewer.example')).origin).toBe('https://viewer.example');
    for (const url of ['http://public.example/video', 'javascript:alert(1)', 'https://secret@example.com/video']) expect(() => watchUrlForStream(url)).toThrow();
  });
  it('preserves a token only for the same provider and deployment name', () => {
    const old = { provider: 'render', name: 'story', adminToken: 'private-token' };
    expect(hostingConfig({ provider: 'render', name: 'story', origin: 'https://story.onrender.com' }, old).adminToken).toBe('private-token');
    expect(hostingConfig({ provider: 'render', name: 'other' }, old)).not.toHaveProperty('adminToken');
    expect(hostingConfig({ provider: 'vm', name: 'story', origin: 'https://story.example' }, old)).not.toHaveProperty('adminToken');
  });
  it('uses private loopback-only tunnels for Fly and SSH hosts', () => {
    expect(connectionCommand({ provider: 'fly', app: 'my-story' })).toEqual({ command: 'fly', args: ['proxy', '4175:4173', '--bind-addr', '127.0.0.1', '--app', 'my-story'] });
    const command = connectionCommand({ provider: 'render', name: 'story', sshTarget: 'srv-example@ssh.ohio.render.com' });
    expect(command.command).toBe('ssh');
    expect(command.args).toContain('127.0.0.1:4175:127.0.0.1:4173');
    expect(() => connectionCommand({ provider: 'render', name: 'story', sshTarget: '-oProxyCommand=evil' })).toThrow();
  });
  it('rejects credential-bearing origins, invalid names and unconfigured VM domains', () => {
    for (const origin of ['http://example.com', 'https://example.com/path', 'https://user:secret@example.com', 'https://example.com?secret=x']) expect(() => hostingConfig({ provider: 'vm', name: 'story', origin })).toThrow();
    expect(() => hostingConfig({ provider: 'vm', name: 'story' })).toThrow();
    expect(() => hostingConfig({ provider: 'render', name: '../story' })).toThrow();
  });
});
