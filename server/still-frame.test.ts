import { describe, expect, it, vi } from 'vitest';

import {
  FalStillFrameError,
  generateStillFrame,
  isFalHostedUrl,
  KLEIN_EDIT_MODEL_ID,
  KLEIN_TEXT_MODEL_ID,
  MAX_STILL_REFERENCE_IMAGES,
} from './still-frame.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const frame = (url = 'https://v3.fal.media/frame.jpg') =>
  json({ images: [{ url, width: 1280, height: 720, content_type: 'image/jpeg' }], seed: 7 });

/** Submit, one COMPLETED poll, then the result read. */
function queue(result: Response) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(json({ request_id: 'still-1' }))
    .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
    .mockResolvedValueOnce(result);
}

const body = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, call = 0) =>
  JSON.parse(String((fetchImpl.mock.calls[call]?.[1] as RequestInit).body));

describe('generateStillFrame', () => {
  it('edits from the certified references and returns the generated frame', async () => {
    const fetchImpl = queue(frame());
    const result = await generateStillFrame({
      prompt: 'Alex leans over the desk, close-up, tense.',
      referenceImageUrls: ['https://v3.fal.media/alex.png', 'https://v3.fal.media/lobby.png'],
    }, { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`https://queue.fal.run/${KLEIN_EDIT_MODEL_ID}`);
    expect(body(fetchImpl)).toMatchObject({
      prompt: 'Alex leans over the desk, close-up, tense.',
      image_urls: ['https://v3.fal.media/alex.png', 'https://v3.fal.media/lobby.png'],
      image_size: 'landscape_16_9',
      num_images: 1,
      num_inference_steps: 4,
      output_format: 'jpeg',
    });
    expect(result).toMatchObject({
      imageUrl: 'https://v3.fal.media/frame.jpg',
      width: 1280,
      height: 720,
      requestId: 'still-1',
      modelId: KLEIN_EDIT_MODEL_ID,
    });
    expect(result.timings.polls).toBe(1);
  });

  // The edit endpoint accepts four references. The planner orders them speaker-first, so the tail
  // is the least load-bearing grounding and is what gets dropped.
  it('caps references at four, keeping the speaker-first order', async () => {
    const fetchImpl = queue(frame());
    const references = ['alex', 'sam', 'rae', 'kit', 'lobby'].map(name => `https://v3.fal.media/${name}.png`);
    await generateStillFrame({ prompt: 'A tense lobby standoff.', referenceImageUrls: references },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 });

    expect(body(fetchImpl).image_urls).toEqual(references.slice(0, MAX_STILL_REFERENCE_IMAGES));
  });

  // Bundles certified before scene images existed have nothing to reference; a text-only frame is
  // still worth more than no playback (PIC-1927, Evan 2026-09-14).
  it('falls back to the text-to-image endpoint when a bundle has no certified images', async () => {
    const fetchImpl = queue(frame());
    const result = await generateStillFrame({ prompt: 'An empty hotel lobby at night.' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`https://queue.fal.run/${KLEIN_TEXT_MODEL_ID}`);
    expect(body(fetchImpl).image_urls).toBeUndefined();
    expect(result.modelId).toBe(KLEIN_TEXT_MODEL_ID);
  });

  it('passes a seed through only when one is requested', async () => {
    const seeded = queue(frame());
    await generateStillFrame({ prompt: 'A quiet diner.', seed: 42 }, { apiKey: 'secret', fetchImpl: seeded, pollIntervalMs: 0 });
    expect(body(seeded).seed).toBe(42);

    const unseeded = queue(frame());
    await generateStillFrame({ prompt: 'A quiet diner.' }, { apiKey: 'secret', fetchImpl: unseeded, pollIntervalMs: 0 });
    expect(body(unseeded)).not.toHaveProperty('seed');
  });
});

describe('generateStillFrame reference handling', () => {
  // PR #36 (PIC-1920) makes the scene-asset cache return the original full-size data URL whenever
  // a content hash is supplied, so references are not guaranteed to be fal-fetchable.
  it('downscales and uploads references fal cannot fetch, and reuses them across a run', async () => {
    const uploaded: string[] = [];
    const referenceUploader = vi.fn(async (bytes: Uint8Array, contentType: string, fileName: string) => {
      uploaded.push(`${contentType}:${bytes.length}:${fileName}`);
      return `https://v3.fal.media/uploaded-${uploaded.length}.jpg`;
    });
    const downscaler = vi.fn(async (bytes: Uint8Array) => ({ bytes: bytes.slice(0, 2), contentType: 'image/jpeg' }));
    const uploadCache = new Map<string, Promise<string>>();
    const options = { apiKey: 'secret', pollIntervalMs: 0, referenceUploader, downscaler, uploadCache };

    // References resolve before the paid submission, so the download answers the first call.
    const first = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'image/png' } }))
      .mockResolvedValueOnce(json({ request_id: 'still-1' }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(frame());
    await generateStillFrame({
      prompt: 'Alex at the desk.',
      // Already on fal's CDN, a foreign HTTPS URL, and an inline data URL.
      referenceImageUrls: ['https://v3.fal.media/alex.png', 'https://images.example/lobby.png', 'data:image/png;base64,AAECAw=='],
    }, { ...options, fetchImpl: first });

    // The fal.media reference is passed through untouched; the other two are uploaded once each.
    expect(body(first, 1).image_urls).toEqual([
      'https://v3.fal.media/alex.png',
      'https://v3.fal.media/uploaded-1.jpg',
      'https://v3.fal.media/uploaded-2.jpg',
    ]);
    expect(downscaler).toHaveBeenCalledTimes(2);

    const second = queue(frame());
    await generateStillFrame({
      prompt: 'Sam answers.',
      referenceImageUrls: ['https://images.example/lobby.png', 'data:image/png;base64,AAECAw=='],
    }, { ...options, fetchImpl: second });

    // A frame per line against the same portraits must not re-upload the same bytes.
    expect(referenceUploader).toHaveBeenCalledTimes(2);
    expect(body(second).image_urls).toEqual(['https://v3.fal.media/uploaded-1.jpg', 'https://v3.fal.media/uploaded-2.jpg']);
  });

  it('passes references through unchanged when no uploader is configured', async () => {
    const fetchImpl = queue(frame());
    await generateStillFrame({ prompt: 'Alex at the desk.', referenceImageUrls: ['data:image/png;base64,AAECAw=='] },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 });
    expect(body(fetchImpl).image_urls).toEqual(['data:image/png;base64,AAECAw==']);
  });

  it('recognizes only fal-hosted HTTPS URLs as already fetchable', () => {
    expect(isFalHostedUrl('https://v3.fal.media/files/frame.jpg')).toBe(true);
    expect(isFalHostedUrl('https://fal.media/frame.jpg')).toBe(true);
    expect(isFalHostedUrl('http://v3.fal.media/frame.jpg')).toBe(false);
    expect(isFalHostedUrl('https://fal.media.example.com/frame.jpg')).toBe(false);
    expect(isFalHostedUrl('data:image/png;base64,AAECAw==')).toBe(false);
    expect(isFalHostedUrl('not a url')).toBe(false);
  });
});

describe('generateStillFrame failures', () => {
  it('rejects a result with no usable image', async () => {
    for (const malformed of [{ images: [] }, { images: [{ width: 1280 }] }, { seed: 1 }]) {
      const fetchImpl = queue(json(malformed));
      await expect(generateStillFrame({ prompt: 'A quiet diner.' }, { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 }))
        .rejects.toThrow(/returned no image/);
    }
  });

  it('rejects a result that is not an image', async () => {
    const fetchImpl = queue(json({ images: [{ url: 'https://v3.fal.media/frame.bin', content_type: 'application/octet-stream' }] }));
    await expect(generateStillFrame({ prompt: 'A quiet diner.' }, { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 }))
      .rejects.toThrow(/not an image/);
  });

  it('rejects a frame the safety checker flagged', async () => {
    const fetchImpl = queue(json({ images: [{ url: 'https://v3.fal.media/frame.jpg' }], has_nsfw_concepts: [true] }));
    await expect(generateStillFrame({ prompt: 'A quiet diner.' }, { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 }))
      .rejects.toBeInstanceOf(FalStillFrameError);
  });

  it('surfaces terminal provider failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'still-failed' }))
      .mockResolvedValueOnce(json({ status: 'FAILED' }));
    await expect(generateStillFrame({ prompt: 'A quiet diner.' }, { apiKey: 'secret', fetchImpl, pollIntervalMs: 0 }))
      .rejects.toThrow(/ended FAILED/);
  });

  it('gives up on a job that outlives its deadline', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'still-slow' }))
      .mockResolvedValue(json({ status: 'IN_QUEUE' }));
    await expect(generateStillFrame({ prompt: 'A quiet diner.' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 0, timeoutMs: 0 })).rejects.toThrow(/timed out/);
  });

  it('cancels an incomplete queue request when the run is aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ request_id: 'still-stop' }))
      .mockResolvedValueOnce(json({ detail: 'temporarily unavailable' }, 503))
      .mockResolvedValueOnce(json({ ok: true }));

    const pending = generateStillFrame({ prompt: 'A quiet diner.' },
      { apiKey: 'secret', fetchImpl, pollIntervalMs: 60_000, signal: controller.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    controller.abort(new DOMException('Renderer stopped', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(`https://queue.fal.run/${KLEIN_TEXT_MODEL_ID}/requests/still-stop/cancel`);
    expect(fetchImpl.mock.calls[2]?.[1]?.method).toBe('PUT');
  });

  it('reports a reference it cannot download instead of generating an ungrounded frame', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ detail: 'gone' }, 404));
    await expect(generateStillFrame({ prompt: 'Alex at the desk.', referenceImageUrls: ['https://images.example/alex.png'] }, {
      apiKey: 'secret', fetchImpl, pollIntervalMs: 0,
      referenceUploader: vi.fn(async () => 'https://v3.fal.media/never.jpg'),
      downscaler: vi.fn(async (bytes: Uint8Array) => ({ bytes, contentType: 'image/jpeg' })),
    })).rejects.toThrow(/reference image download failed \(404\)/);
    // The paid submission is never reached.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
