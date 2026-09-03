import { afterEach, describe, expect, it, vi } from 'vitest';

const hlsMocks = vi.hoisted(() => ({
  isSupported: vi.fn(),
  on: vi.fn(),
  loadSource: vi.fn(),
  attachMedia: vi.fn(),
  startLoad: vi.fn(),
  stopLoad: vi.fn(),
  recoverMediaError: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('hls.js', () => ({
  default: class MockHls {
    static isSupported = hlsMocks.isSupported;
    static Events = { ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    on = hlsMocks.on;
    loadSource = hlsMocks.loadSource;
    attachMedia = hlsMocks.attachMedia;
    startLoad = hlsMocks.startLoad;
    stopLoad = hlsMocks.stopLoad;
    recoverMediaError = hlsMocks.recoverMediaError;
    destroy = hlsMocks.destroy;
  },
}));

import { attachHlsPlayer, enqueuePlayoutClip, getPlayoutStatus, skipPlayoutPosition, startPlayout, stopPlayout } from './playout';
import type { GeneratedClip } from './types';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const status = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  hlsUrl: 'http://localhost:8888/h3-session/index.m3u8',
  state: 'buffering' as const,
  normalizedClips: 0,
  pendingClips: 0,
  currentPosition: null,
  playedThroughPosition: -1,
  outputSeconds: 0,
  error: null,
};

const clip: GeneratedClip = {
  id: 'clip-1', storyBlockId: 'beat-1', prompt: 'prompt',
  videoUrl: 'https://video.example/one.mp4', requestId: 'request-1', createdAt: 1,
  durationSeconds: 5, totalSeconds: 3, generationMs: 3_000,
  generationMode: 'reference', referenceCharacters: ['June Morrison'],
};

describe('playout client', () => {
  it('prefers hls.js when embedded Chromium falsely advertises native HLS', () => {
    hlsMocks.isSupported.mockReturnValue(true);
    const video = {
      canPlayType: vi.fn().mockReturnValue('maybe'),
      src: '',
      load: vi.fn(),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
    } as unknown as HTMLVideoElement;

    const detach = attachHlsPlayer(video, status.hlsUrl, vi.fn());

    expect(hlsMocks.loadSource).toHaveBeenCalledWith(status.hlsUrl);
    expect(hlsMocks.attachMedia).toHaveBeenCalledWith(video);
    expect(video.src).toBe('');

    detach();
    expect(hlsMocks.destroy).toHaveBeenCalledOnce();
  });

  it('uses native HLS only when MediaSource playback is unavailable', () => {
    hlsMocks.isSupported.mockReturnValue(false);
    const video = {
      canPlayType: vi.fn().mockReturnValue('probably'),
      src: '',
      load: vi.fn(),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
    } as unknown as HTMLVideoElement;

    attachHlsPlayer(video, status.hlsUrl, vi.fn());

    expect(video.src).toBe(status.hlsUrl);
    expect(hlsMocks.attachMedia).not.toHaveBeenCalled();
  });

  it('reloads the manifest after a fatal network interruption', () => {
    vi.useFakeTimers();
    hlsMocks.isSupported.mockReturnValue(true);
    const video = {
      canPlayType: vi.fn(),
      load: vi.fn(),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
    } as unknown as HTMLVideoElement;

    const detach = attachHlsPlayer(video, status.hlsUrl, vi.fn());
    const errorHandler = hlsMocks.on.mock.calls[0]?.[1] as (
      event: string,
      data: { fatal: boolean; type: string; details: string },
    ) => void;
    errorHandler('error', { fatal: true, type: 'networkError', details: 'manifestLoadError' });

    expect(hlsMocks.stopLoad).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_000);
    expect(hlsMocks.loadSource).toHaveBeenCalledTimes(2);
    expect(hlsMocks.loadSource).toHaveBeenLastCalledWith(status.hlsUrl);

    detach();
    vi.useRealTimers();
  });

  it('starts, enqueues, reads, and stops one server-owned stream session', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ stopped: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(startPlayout()).resolves.toEqual(status);
    await enqueuePlayoutClip(status.sessionId, clip, 4);
    await skipPlayoutPosition(status.sessionId, 5);
    await getPlayoutStatus(status.sessionId);
    await stopPlayout(status.sessionId);

    expect(fetchMock.mock.calls[1]?.[0]).toContain('/clips');
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({
      position: 4,
      storyBlockId: 'beat-1',
      videoUrl: clip.videoUrl,
      durationSeconds: 5,
    });
    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))).toEqual({ position: 5, skip: true });
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({ method: 'DELETE' });
  });
});
