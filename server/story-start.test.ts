import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestStoryStart, requestTransientDependency, STORY_START_TIMEOUT_MS } from './story-start.js';

const body = { evd_id: 'fixture-evd', idempotency_key: 'fixture-same-run' };
const options = (controller = new AbortController()) => ({
  url: 'http://kernel.test/api/v1/renderers/start-story', accessToken: 'fixture-token',
  body, signal: controller.signal, retryAmbiguous: true, onResponse: vi.fn(),
  readResponse: async (response: Response) => { await response.text(); return response; },
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('opaque start recovery', () => {
  it('recovers a transient dependency 503 without replaying the accepted start', async () => {
    vi.useFakeTimers();
    const startFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    const dependencyFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', startFetch);
    const retries = vi.fn();
    const result = requestStoryStart({
      ...options(),
      afterAccepted: async (_response, signal) => {
        await requestTransientDependency({
          signal,
          request: dependencyFetch,
          readResponse: async response => response.status,
          onRetry: retries,
        });
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await result).status).toBe(202);
    expect(startFetch).toHaveBeenCalledTimes(1);
    expect(dependencyFetch).toHaveBeenCalledTimes(2);
    expect(retries).toHaveBeenCalledWith({ kind: 'http', status: 503 });
  });

  it('recovers a transient dependency transport failure', async () => {
    vi.useFakeTimers();
    const dependencyFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('fixture connection reset'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const retries = vi.fn();
    const result = requestTransientDependency({
      signal: new AbortController().signal,
      request: dependencyFetch,
      readResponse: async response => response.status,
      onRetry: retries,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(200);
    expect(dependencyFetch).toHaveBeenCalledTimes(2);
    expect(retries).toHaveBeenCalledWith({ kind: 'transport', errorName: 'TypeError' });
    expect(JSON.stringify(retries.mock.calls)).not.toContain('fixture connection reset');
  });

  it('keeps persistent dependency failures inside the original start deadline', async () => {
    vi.useFakeTimers();
    const startFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    const dependencyFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', startFetch);
    const result = requestStoryStart({
      ...options(),
      afterAccepted: async (_response, signal) => {
        await requestTransientDependency({
          signal,
          request: dependencyFetch,
          readResponse: async response => response.status,
          onRetry: vi.fn(),
        });
      },
    });
    const assertion = expect(result).rejects.toThrow('Story start recovery timed out');
    await vi.advanceTimersByTimeAsync(STORY_START_TIMEOUT_MS);
    await assertion;
    expect(startFetch).toHaveBeenCalledTimes(1);
    expect(dependencyFetch).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels dependency recovery promptly on stop', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const startFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    const dependencyFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', startFetch);
    const result = requestStoryStart({
      ...options(controller),
      afterAccepted: async (_response, signal) => {
        await requestTransientDependency({
          signal,
          request: dependencyFetch,
          readResponse: async response => response.status,
          onRetry: vi.fn(),
        });
      },
    });
    const assertion = expect(result).rejects.toThrow('user stop');
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error('user stop'));
    await assertion;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(startFetch).toHaveBeenCalledTimes(1);
    expect(dependencyFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403, 404, 409, 422])('does not retry terminal dependency HTTP %s', async status => {
    const dependencyFetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    const retries = vi.fn();
    await expect(requestTransientDependency({
      signal: new AbortController().signal,
      request: dependencyFetch,
      readResponse: async response => { throw new Error(`terminal ${response.status}`); },
      onRetry: retries,
    })).rejects.toThrow(`terminal ${status}`);
    expect(dependencyFetch).toHaveBeenCalledTimes(1);
    expect(retries).not.toHaveBeenCalled();
  });

  it.each([408, 502, 503, 504])('replays HTTP %s using the identical body and bearer', async status => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    const input = options();
    const result = requestStoryStart(input);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await result).status).toBe(202);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(body);
    expect(input.onResponse.mock.calls).toEqual([[status], [202]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers an ambiguous transport disconnect', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    const result = requestStoryStart(options());
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await result).status).toBe(202);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 409, 422, 500])('does not retry a terminal HTTP %s', async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal('fetch', fetcher);
    expect((await requestStoryStart(options())).status).toBe(status);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy starts single-attempt', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 502 }));
    vi.stubGlobal('fetch', fetcher);
    expect((await requestStoryStart({ ...options(), retryAmbiguous: false })).status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight start when stopped', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    })));
    const result = requestStoryStart(options(controller));
    const assertion = expect(result).rejects.toThrow('user stop');
    controller.abort(new Error('user stop'));
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts backoff without issuing another start', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 502 }));
    vi.stubGlobal('fetch', fetcher);
    const result = requestStoryStart(options(controller));
    const assertion = expect(result).rejects.toThrow('user stop');
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error('user stop'));
    await assertion;
    await vi.advanceTimersByTimeAsync(STORY_START_TIMEOUT_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds repeated gateway failures by one overall deadline', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 504 }));
    vi.stubGlobal('fetch', fetcher);
    const result = requestStoryStart(options());
    const assertion = expect(result).rejects.toThrow('kernel may still own this run');
    await vi.advanceTimersByTimeAsync(STORY_START_TIMEOUT_MS);
    await assertion;
    const count = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STORY_START_TIMEOUT_MS);
    expect(fetcher).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a request that never returns headers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    })));
    const result = requestStoryStart(options());
    const assertion = expect(result).rejects.toThrow('Story start recovery timed out');
    await vi.advanceTimersByTimeAsync(STORY_START_TIMEOUT_MS);
    await assertion;
  });

  it('keeps the deadline through a stalled accepted response body', async () => {
    vi.useFakeTimers();
    const response = new Response(new ReadableStream({ start() {} }), { status: 202 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const result = requestStoryStart(options());
    const assertion = expect(result).rejects.toThrow('Story start recovery timed out');
    await vi.advanceTimersByTimeAsync(STORY_START_TIMEOUT_MS);
    await assertion;
  });

  it('replays the same start when its accepted body loses transport', async () => {
    vi.useFakeTimers();
    const response = new Response(new ReadableStream({ start(controller) {
      controller.error(new TypeError('terminated'));
    } }), { status: 202 });
    const fetcher = vi.fn().mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    const result = requestStoryStart(options());
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await result).status).toBe(202);
    expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
  });
});
