import { describe, expect, it, vi } from 'vitest';
import { generateMiniMaxVideo } from './minimax.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('generateMiniMaxVideo', () => {
  it('uses MiniMax H3 Max directly and returns the completed video URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ task_id: 'task-1' }))
      .mockResolvedValueOnce(json({ task: { status: 'processing' } }))
      .mockResolvedValueOnce(json({ task: { status: 'succeeded', content: { url: 'https://cdn.example/video.mp4' } } }));
    const result = await generateMiniMaxVideo(
      { prompt: 'A noir diner', duration: 5, resolution: '768P', aspectRatio: '16:9' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    );
    expect(result.videoUrl).toBe('https://cdn.example/video.mp4');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.minimax.io/v2/video_generation');
    expect(JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ model: 'MiniMax-H3-Max', duration: 5, resolution: '768P', ratio: '16:9' });
  });

  it('uses MiniMax H3 for reference generation', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ task_id: 'task-ref' }))
      .mockResolvedValueOnce(json({ task: { status: 'succeeded', content: { url: 'https://cdn.example/ref.mp4' } } }));
    await generateMiniMaxVideo(
      { prompt: 'Marcus enters', duration: 5, resolution: '768P', aspectRatio: '16:9', referenceImageUrls: ['data:image/jpeg;base64,AAAA'] },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    );
    expect(JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ model: 'MiniMax-H3', content: expect.arrayContaining([{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' }, role: 'reference_image' }]) });
  });
});
