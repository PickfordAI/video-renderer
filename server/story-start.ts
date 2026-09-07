import { setTimeout as delay } from 'node:timers/promises';

// Covers synchronous kernel preparation and readiness, including a replay after
// a gateway loses the response. This is one budget, not a fresh budget per retry.
export const STORY_START_TIMEOUT_MS = 180_000;
const RETRY_DELAY_MS = 1_000;
const RETRYABLE_STATUS = new Set([408, 502, 503, 504]);

export type TransientDependencyRetry =
  | { kind: 'transport'; errorName: string }
  | { kind: 'http'; status: number };

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export async function requestStoryStart<T>(options: {
  url: string;
  accessToken: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
  retryAmbiguous: boolean;
  onResponse: (status: number) => void;
  readResponse: (response: Response) => Promise<T>;
  afterAccepted?: (result: T, recoverySignal: AbortSignal) => Promise<void>;
}): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(
    'Story start recovery timed out; the kernel may still own this run. Stop or reconcile it before starting another story.',
  )), STORY_START_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  // Serialize once: retries must never allocate another idempotency key or EVD.
  const body = JSON.stringify(options.body);
  try {
    while (true) {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(options.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.accessToken}`, 'Content-Type': 'application/json' },
          body,
          signal,
        });
      } catch (error) {
        signal.throwIfAborted();
        // Fetch transport failures have an ambiguous server outcome. Only the
        // opaque contract guarantees safe replay of this exact start identity.
        if (!options.retryAmbiguous || !(error instanceof TypeError)) throw error;
        await delay(RETRY_DELAY_MS, undefined, { signal });
        continue;
      }
      options.onResponse(response.status);
      if (!options.retryAmbiguous || !RETRYABLE_STATUS.has(response.status)) {
        let result: T;
        try {
          // Headers are not completion: a lost or stalled accepted body has the
          // same ambiguous outcome as losing the response before headers.
          result = await withAbort(options.readResponse(response), signal);
        } catch (error) {
          signal.throwIfAborted();
          if (!options.retryAmbiguous || response.status !== 202 || !(error instanceof TypeError)) throw error;
          await delay(RETRY_DELAY_MS, undefined, { signal });
          continue;
        }
        // Opaque identity resolution is part of committing a usable start, so
        // keep it inside this same deadline instead of starting a new budget.
        await options.afterAccepted?.(result, signal);
        return result;
      } else {
        await response.body?.cancel();
      }
      await delay(RETRY_DELAY_MS, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestTransientDependency<T>(options: {
  signal: AbortSignal;
  request: () => Promise<Response>;
  readResponse: (response: Response) => Promise<T>;
  onRetry: (reason: TransientDependencyRetry) => void;
}): Promise<T> {
  while (true) {
    options.signal.throwIfAborted();
    let response: Response;
    try {
      response = await options.request();
    } catch (error) {
      options.signal.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
      options.onRetry({ kind: 'transport', errorName: error.name });
      await delay(RETRY_DELAY_MS, undefined, { signal: options.signal });
      continue;
    }
    if (response.status < 500 || response.status > 599) {
      try {
        return await withAbort(options.readResponse(response), options.signal);
      } catch (error) {
        options.signal.throwIfAborted();
        if (!(error instanceof TypeError)) throw error;
        options.onRetry({ kind: 'transport', errorName: error.name });
        await delay(RETRY_DELAY_MS, undefined, { signal: options.signal });
        continue;
      }
    }
    options.onRetry({ kind: 'http', status: response.status });
    await response.body?.cancel();
    await delay(RETRY_DELAY_MS, undefined, { signal: options.signal });
  }
}
