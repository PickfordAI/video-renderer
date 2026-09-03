import { describe, expect, it, vi } from 'vitest';

import { FalVideoError, generateVideo } from './fal.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('generateVideo', () => {
  it('runs the fal queue protocol and returns its video URL', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'request-1', status_url: 'https://fal/status', response_url: 'https://fal/result' }))
      .mockResolvedValueOnce(json({ status: 'IN_QUEUE' }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(json({ video: { url: 'https://cdn.example/clip.mp4' }, expanded_prompt: 'Expanded' }));

    const result = await generateVideo(
      { prompt: 'A cinematic diner at night', duration: 5, resolution: '768P', aspectRatio: '16:9' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    );

    expect(result.videoUrl).toBe('https://cdn.example/clip.mp4');
    expect(result.requestId).toBe('request-1');
    expect(result.generationMode).toBe('text');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const submit = fetchImpl.mock.calls[0];
    expect(submit?.[0]).toBe('https://queue.fal.run/minimax/h3-max-turbo/text-to-video');
    expect(JSON.parse(String((submit?.[1] as RequestInit).body))).toMatchObject({
      duration: 5,
      resolution: '768P',
      aspect_ratio: '16:9',
      prompt_expansion_mode: 'balanced',
    });
  });

  it('uses the reference-to-video endpoint and forwards ordered image and audio references', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'request-ref' }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(json({ video: { url: 'https://cdn.example/reference.mp4' } }));

    const result = await generateVideo(
      {
        prompt: 'Image 1 is Marcus Kent. He studies the ledger.',
        duration: 8,
        resolution: '768P',
        aspectRatio: '16:9',
        referenceImageUrls: ['data:image/jpeg;base64,AAAA'],
        referenceAudioUrls: ['https://audio.example/kent.mp3'],
      },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    );

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://queue.fal.run/minimax/h3-max/reference-to-video');
    expect(JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      reference_image_urls: ['data:image/jpeg;base64,AAAA'],
      reference_audio_urls: ['https://audio.example/kent.mp3'],
    });
    expect(result.generationMode).toBe('reference');
  });

  it('uses reference-to-video for an audio-only reference request', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'request-audio' }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(json({ video: { url: 'https://cdn.example/audio-reference.mp4' } }));

    await generateVideo(
      {
        prompt: 'Audio 1 is the voice for the detective.',
        duration: 5,
        resolution: '480P',
        aspectRatio: '16:9',
        referenceAudioUrls: ['https://audio.example/detective.mp3'],
      },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    );

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://queue.fal.run/minimax/h3-max/reference-to-video');
  });

  it('surfaces terminal provider failures', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'request-2' }))
      .mockResolvedValueOnce(json({ status: 'FAILED' }));

    await expect(
      generateVideo(
        { prompt: 'A cinematic diner at night', duration: 5, resolution: '480P', aspectRatio: '16:9' },
        { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
      ),
    ).rejects.toBeInstanceOf(FalVideoError);
  });

  it('cancels a submitted fal request when the renderer stops', async () => {
    const controller = new AbortController();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'request-stop' }))
      .mockResolvedValueOnce(json({ status: 'IN_QUEUE' }))
      .mockResolvedValueOnce(json({ ok: true }));

    const pending = generateVideo(
      { prompt: 'A cinematic diner at night', duration: 5, resolution: '768P', aspectRatio: '16:9' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 60_000, signal: controller.signal },
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    controller.abort(new DOMException('Renderer stopped', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      'https://queue.fal.run/minimax/h3-max-turbo/text-to-video/requests/request-stop/cancel',
    );
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ method: 'PUT' });
  });
});
