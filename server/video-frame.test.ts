import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { extractVideoFrame } from './video-frame.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const source = 'https://v3.fal.media/clip.mp4';
describe('extractVideoFrame', () => {
  beforeEach(() => { vi.mocked(execFile).mockReset(); });
  it.each(['first', 'last'] as const)('extracts the %s frame from a bounded local copy', async position => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: null, output: Buffer) => void;
      callback(null, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
      return undefined as never;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const result = await extractVideoFrame(source, { position, fetchImpl });
    expect(result).toBe('data:image/jpeg;base64,/9j/AA==');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    const args = vi.mocked(execFile).mock.calls[0]?.[1] as string[];
    expect(args).toContain('file,pipe');
    expect(args).not.toContain(source);
    expect(args.includes('-sseof')).toBe(position === 'last');
  });
  it('fails closed before download for arbitrary URLs, redirects, oversized media, and Stop', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(extractVideoFrame('http://localhost/secret', { position: 'last', fetchImpl })).rejects.toThrow('fal.media');
    await expect(extractVideoFrame('https://fal.media.evil.example/clip', { position: 'last', fetchImpl })).rejects.toThrow('fal.media');
    const controller = new AbortController(); controller.abort();
    await expect(extractVideoFrame(source, { position: 'last', fetchImpl, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValue(new Response('large', { headers: { 'content-length': String(81 * 1024 * 1024) } }));
    await expect(extractVideoFrame(source, { position: 'last', fetchImpl })).rejects.toThrow('80 MB');
    expect(execFile).not.toHaveBeenCalled();
  });
  it('does not return an unusable frame when decoding fails', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args[3] as (error: Error, output: Buffer) => void)(new Error('invalid media'), Buffer.alloc(0));
      return undefined as never;
    });
    await expect(extractVideoFrame(source, { position: 'last', fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('invalid')) })).rejects.toThrow('Could not extract');
  });
});
