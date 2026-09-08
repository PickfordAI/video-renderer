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

  it('rejects unsupported audio-only requests before paying for generation', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(generateVideo(
      {
        prompt: 'Audio 1 is the voice for the detective.',
        duration: 5,
        resolution: '480P',
        aspectRatio: '16:9',
        referenceAudioUrls: ['https://audio.example/detective.mp3'],
      },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    )).rejects.toThrow('at least one image');
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it('recovers transient status and result reads without replaying the paid submission', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'request-retry' }))
      .mockResolvedValueOnce(json({ detail: 'status unavailable' }, 503))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(json({ detail: [{ type: 'downstream_service_unavailable' }] }, 504))
      .mockResolvedValueOnce(json({ video: { url: 'https://cdn.example/recovered.mp4' } }));

    const result = await generateVideo(
      { prompt: 'A cinematic diner at night', duration: 5, resolution: '480P', aspectRatio: '16:9' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    );

    expect(result.videoUrl).toBe('https://cdn.example/recovered.mp4');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchImpl.mock.calls.slice(1, 3).map(([url]) => url)).toEqual([
      'https://queue.fal.run/minimax/h3-max-turbo/text-to-video/requests/request-retry/status',
      'https://queue.fal.run/minimax/h3-max-turbo/text-to-video/requests/request-retry/status',
    ]);
    expect(fetchImpl.mock.calls.slice(3).map(([url]) => url)).toEqual([
      'https://queue.fal.run/minimax/h3-max-turbo/text-to-video/requests/request-retry',
      'https://queue.fal.run/minimax/h3-max-turbo/text-to-video/requests/request-retry',
    ]);
  });

  it('keeps recovering completed results beyond the status-read retry budget without replaying submission', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'request-result-recovery' }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }));
    for (let attempt = 0; attempt < 7; attempt += 1) {
      fetchImpl.mockResolvedValueOnce(json({ detail: 'result service unavailable' }, 504));
    }
    fetchImpl.mockResolvedValueOnce(json({ video: { url: 'https://cdn.example/recovered-late.mp4' } }));

    await expect(generateVideo(
      { prompt: 'A cinematic diner at night', duration: 5, resolution: '480P', aspectRatio: '16:9' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    )).resolves.toMatchObject({
      requestId: 'request-result-recovery',
      videoUrl: 'https://cdn.example/recovered-late.mp4',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('does not retry terminal fal read responses', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'request-terminal' }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(json({ detail: 'invalid key' }, 401));

    await expect(generateVideo(
      { prompt: 'A cinematic diner at night', duration: 5, resolution: '480P', aspectRatio: '16:9' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    )).rejects.toThrow('fal result fetch failed (401)');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('recovers a transient transport failure while polling the same request', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'request-transport' }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(json({ video: { url: 'https://cdn.example/recovered.mp4' } }));

    await expect(generateVideo(
      { prompt: 'A cinematic diner at night', duration: 5, resolution: '480P', aspectRatio: '16:9' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    )).resolves.toMatchObject({ requestId: 'request-transport' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('bounds repeated transient fal reads', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'request-exhausted' }))
      .mockResolvedValue(json({ detail: 'downstream unavailable' }, 504));

    await expect(generateVideo(
      { prompt: 'A cinematic diner at night', duration: 5, resolution: '480P', aspectRatio: '16:9' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    )).rejects.toThrow('fal status poll failed (504)');
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it('aborts a transient-read retry delay and cancels an incomplete request', async () => {
    const controller = new AbortController();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'request-retry-stop' }))
      .mockResolvedValueOnce(json({ detail: 'temporarily unavailable' }, 503))
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
      'https://queue.fal.run/minimax/h3-max-turbo/text-to-video/requests/request-retry-stop/cancel',
    );
  });

  it('pins explicit Turbo i2v to its endpoint and sends only the first frame, without voice references', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'image-request' }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(json({ video: { url: 'https://v3.fal.media/clip.mp4' } }));
    const result = await generateVideo({
      prompt: 'The detective looks toward the doorway.', duration: 5, resolution: '480P', aspectRatio: '16:9',
      renderMode: 'fal-turbo-i2v', initialImageUrl: 'data:image/jpeg;base64,/9j/AAAA',
      referenceImageUrls: ['https://images.example/character.jpg'], referenceAudioUrls: ['https://audio.example/voice.mp3'],
    }, { apiKey: 'secret', modelId: 'ignored', referenceModelId: 'ignored', fetchImpl });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://queue.fal.run/minimax/h3-max-turbo/image-to-video');
    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(payload.image_url).toBe('data:image/jpeg;base64,/9j/AAAA');
    expect(payload.reference_image_urls).toBeUndefined();
    expect(payload.reference_audio_urls).toBeUndefined();
    expect(result.generationMode).toBe('image');
  });

  it('pins explicit Max ref2v and preserves numbered refs before the optional scene anchor', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'ref-request' }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(json({ video: { url: 'https://v3.fal.media/clip.mp4' } }));
    await generateVideo({
      prompt: 'Image 1 is the detective; Audio 1 is his voice.', duration: 5, resolution: '480P', aspectRatio: '16:9',
      renderMode: 'fal-max-ref2v', initialImageUrl: 'https://images.example/scene.jpg',
      referenceImageUrls: ['https://images.example/character.jpg'], referenceAudioUrls: ['data:audio/mpeg;base64,AAAA'],
    }, { apiKey: 'secret', modelId: 'ignored', referenceModelId: 'ignored', fetchImpl });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://queue.fal.run/minimax/h3-max/reference-to-video');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      reference_image_urls: ['https://images.example/character.jpg', 'https://images.example/scene.jpg'],
      reference_audio_urls: ['data:audio/mp3;base64,AAAA'],
    });
  });

  it('rejects missing explicit-mode assets and excess references before any paid submission', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const input = { prompt: 'The detective looks toward the doorway.', duration: 5, resolution: '480P', aspectRatio: '16:9' } as const;
    await expect(generateVideo({ ...input, renderMode: 'fal-turbo-i2v' }, { apiKey: 'secret', fetchImpl })).rejects.toThrow('requires an initial');
    await expect(generateVideo({ ...input, renderMode: 'fal-max-ref2v' }, { apiKey: 'secret', fetchImpl })).rejects.toThrow('requires a character');
    await expect(generateVideo({ ...input, referenceImageUrls: Array(13).fill('https://images.example/ref.jpg') }, { apiKey: 'secret', fetchImpl })).rejects.toThrow('limits');
    expect(fetchImpl).not.toHaveBeenCalled();
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
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ method: 'PUT', signal: expect.any(AbortSignal) });
  });
});

describe('generateVideo transient failure handling', () => {
  const handle = () => json({ request_id: 'request-retry', status_url: 'https://fal/status', response_url: 'https://fal/result' });

  it('retries a network-level fetch failure during status polling instead of fencing the run', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(handle())
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(json({ video: { url: 'https://cdn.example/retried.mp4' } }));

    const result = await generateVideo(
      { prompt: 'A cinematic diner at night', duration: 5, resolution: '768P', aspectRatio: '16:9' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    );

    expect(result.videoUrl).toBe('https://cdn.example/retried.mp4');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  }, 15_000);

  it('retries a 503 on submit and then proceeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(handle())
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(json({ video: { url: 'https://cdn.example/after-503.mp4' } }));

    const result = await generateVideo(
      { prompt: 'A cinematic diner at night', duration: 5, resolution: '768P', aspectRatio: '16:9' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
    );
    expect(result.videoUrl).toBe('https://cdn.example/after-503.mp4');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(fetchImpl.mock.calls[1]?.[0]);
  }, 15_000);

  it('gives up with the underlying cause after repeated network failures', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));

    await expect(
      generateVideo(
        { prompt: 'A cinematic diner at night', duration: 5, resolution: '768P', aspectRatio: '16:9' },
        { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
      ),
    ).rejects.toThrow(/fal submit failed after 4 attempts: fetch failed \(ENOTFOUND\)/);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  }, 20_000);

  it('does not retry a client error, which would fail identically', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('bad request', { status: 422 }));
    await expect(
      generateVideo(
        { prompt: 'A cinematic diner at night', duration: 5, resolution: '768P', aspectRatio: '16:9' },
        { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 },
      ),
    ).rejects.toBeInstanceOf(FalVideoError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
