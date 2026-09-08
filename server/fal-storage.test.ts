import { describe, expect, it, vi } from 'vitest';

import { FalStorageError, falReferenceUploader, sceneAssetTransport, uploadDataUrl, uploadToFalStorage } from './fal-storage.js';
import { MinimaxSceneAssetCache } from './scene-context.js';

const handle = { upload_url: 'https://v3b.fal.media/files/b/x/probe.png?signature=s', file_url: 'https://v3b.fal.media/files/b/x/probe.png' };

describe('uploadToFalStorage', () => {
  it('initiates, PUTs the bytes, and returns the public file URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(handle))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const url = await uploadToFalStorage(new Uint8Array([1, 2, 3]), 'image/png', 'asset.png', { apiKey: 'k', fetchImpl });
    expect(url).toBe(handle.file_url);
    const [initiate, put] = fetchImpl.mock.calls;
    expect(String(initiate?.[0])).toContain('/storage/upload/initiate?storage_type=fal-cdn-v3');
    expect((initiate?.[1] as RequestInit).headers).toMatchObject({ Authorization: 'Key k' });
    expect(JSON.parse(String((initiate?.[1] as RequestInit).body))).toEqual({ content_type: 'image/png', file_name: 'asset.png' });
    expect(put?.[0]).toBe(handle.upload_url);
    expect((put?.[1] as RequestInit).method).toBe('PUT');
  });

  it('fails loudly when the upload is rejected', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(handle))
      .mockResolvedValueOnce(new Response('denied', { status: 403 }));
    await expect(uploadToFalStorage(new Uint8Array([1]), 'image/png', 'a.png', { apiKey: 'k', fetchImpl })).rejects.toBeInstanceOf(FalStorageError);
  });

  it('defaults to the storage transport and honours the inline override', () => {
    expect(sceneAssetTransport({})).toBe('storage');
    expect(sceneAssetTransport({ FAL_SCENE_ASSET_TRANSPORT: 'inline' })).toBe('inline');
  });

  it('turns an extracted frame data URL into one storage upload', async () => {
    const seen: Array<[number, string, string]> = [];
    const uploader = vi.fn(async (bytes: Uint8Array, contentType: string, fileName: string) => {
      seen.push([bytes.byteLength, contentType, fileName]);
      return 'https://v3b.fal.media/files/frame.jpg';
    });
    await expect(uploadDataUrl(`data:image/jpeg;base64,${btoa('jpegbytes')}`, 'frame-a.jpg', uploader)).resolves.toBe('https://v3b.fal.media/files/frame.jpg');
    expect(seen).toEqual([[9, 'image/jpeg', 'frame-a.jpg']]);
    await expect(uploadDataUrl('https://not-a-data-url', 'x.jpg', uploader)).rejects.toBeInstanceOf(FalStorageError);
  });
});

describe('MinimaxSceneAssetCache with an uploader', () => {
  const image = (assetId: string, sourceId: string, characterName?: string) => ({
    assetId, sourceId, imageUrl: `https://assets.example/${assetId}.png`, ...(characterName ? { characterName } : {}),
  });

  it('uploads each certified asset once and references the storage URL instead of inlining bytes', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => new Response(new TextEncoder().encode(`bytes:${String(input)}`), {
      status: 200, headers: { 'Content-Type': 'image/png' },
    })) as typeof fetch;
    try {
      const uploads: string[] = [];
      const uploader = vi.fn(async (_bytes: Uint8Array, contentType: string, fileName: string) => {
        uploads.push(`${contentType}:${fileName}`);
        return `https://v3b.fal.media/files/${fileName}`;
      });
      const cache = new MinimaxSceneAssetCache({ uploader });
      const context = {
        setImage: image('11111111-1111-4111-8111-111111111111', 'lobby'),
        characterImages: [image('22222222-2222-4222-8222-222222222222', 'maya', 'Maya')],
        characterPositions: { maya: 'left' },
      };
      const first = await cache.resolve(context as never);
      const second = await cache.resolve(context as never);
      expect(first.setImage.imageUrl).toBe('https://v3b.fal.media/files/11111111-1111-4111-8111-111111111111.png');
      expect(first.characterImages[0]?.imageUrl).toBe('https://v3b.fal.media/files/22222222-2222-4222-8222-222222222222.png');
      expect(second.setImage.imageUrl).toBe(first.setImage.imageUrl);
      expect(uploads).toEqual([
        'image/png:11111111-1111-4111-8111-111111111111.png',
        'image/png:22222222-2222-4222-8222-222222222222.png',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps the inline data URL when no uploader is configured', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(new TextEncoder().encode('png'), { status: 200, headers: { 'Content-Type': 'image/png' } })) as typeof fetch;
    try {
      const cache = new MinimaxSceneAssetCache();
      const resolved = await cache.resolve({
        setImage: image('11111111-1111-4111-8111-111111111111', 'lobby'), characterImages: [], characterPositions: {},
      } as never);
      expect(resolved.setImage.imageUrl).toBe(`data:image/png;base64,${btoa('png')}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('binds the key for callers that only know how to hand over bytes', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(handle))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const upload = falReferenceUploader('k', fetchImpl);
    await expect(upload(new Uint8Array([1]), 'image/png', 'a.png')).resolves.toBe(handle.file_url);
  });
});

describe('isResolvedSceneImage', () => {
  it('accepts pinned bytes as a data URL or a fal storage URL and nothing else', async () => {
    const { isResolvedSceneImage } = await import('./shot-planner.js');
    expect(isResolvedSceneImage(`data:image/png;base64,${btoa('png')}`)).toBe(true);
    expect(isResolvedSceneImage('https://v3b.fal.media/files/b/x/asset.png')).toBe(true);
    expect(isResolvedSceneImage('https://storage.googleapis.com/bucket/asset.png?X-Goog-Signature=x')).toBe(false);
    expect(isResolvedSceneImage('http://fal.media/insecure.png')).toBe(false);
  });
});

describe('MinimaxSceneAssetCache downscaling before upload', () => {
  it('runs the downscaler on the fetched bytes and uploads its output type', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(new TextEncoder().encode('big-png-bytes'), { status: 200, headers: { 'Content-Type': 'image/png' } })) as typeof fetch;
    try {
      const uploaded: Array<[number, string, string]> = [];
      const uploader = vi.fn(async (bytes: Uint8Array, contentType: string, fileName: string) => {
        uploaded.push([bytes.byteLength, contentType, fileName]);
        return `https://v3b.fal.media/files/${fileName}`;
      });
      const downscale = vi.fn(async (bytes: Uint8Array) => ({ bytes: bytes.subarray(0, 3), contentType: 'image/jpeg' }));
      const cache = new MinimaxSceneAssetCache({ uploader, downscale });
      const resolved = await cache.resolve({
        setImage: { assetId: '11111111-1111-4111-8111-111111111111', sourceId: 'lobby', imageUrl: 'https://assets.example/lobby.png' },
        characterImages: [], characterPositions: {},
      } as never);
      expect(downscale).toHaveBeenCalledTimes(1);
      expect(uploaded).toEqual([[3, 'image/jpeg', '11111111-1111-4111-8111-111111111111.jpeg']]);
      expect(resolved.setImage.imageUrl).toBe('https://v3b.fal.media/files/11111111-1111-4111-8111-111111111111.jpeg');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reads the reference edge from the environment and lets 0 disable downscaling', async () => {
    const { referenceMaxEdge } = await import('./image-downscale.js');
    expect(referenceMaxEdge({})).toBe(1024);
    expect(referenceMaxEdge({ FAL_REFERENCE_MAX_EDGE: '768' })).toBe(768);
    expect(referenceMaxEdge({ FAL_REFERENCE_MAX_EDGE: '0' })).toBe(0);
    expect(referenceMaxEdge({ FAL_REFERENCE_MAX_EDGE: 'nope' })).toBe(1024);
  });
});
