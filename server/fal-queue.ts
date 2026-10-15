/**
 * The fal queue protocol, shared by every fal adapter in this repo.
 *
 * Submitting a job, polling its status to a terminal state, and reading the paid result back are
 * identical for video and image models; only the request body and the shape of the result differ.
 * PIC-1972 lifted this out of `fal.ts` unchanged so the still-image provider inherits the retry,
 * timeout and cancellation behaviour that several production incidents shaped, rather than growing
 * a second, thinner client beside it.
 *
 * Callers supply `makeError` so each adapter surfaces its own typed error class; the queue core
 * never decides what kind of failure a caller wants to report.
 */

const TERMINAL_ERROR_STATUSES = new Set(['ERROR', 'FAILED', 'CANCELLED']);
const RETRYABLE_READ_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_READ_RETRIES = 5;
const MAX_READ_RETRY_DELAY_MS = 5_000;

// Provider statuses worth one more try. 4xx other than these are the caller's fault and
// would fail identically on retry; success and non-listed statuses return to the caller.
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const FETCH_ATTEMPTS = 4;
const FETCH_RETRY_BASE_MS = 500;

export type FalErrorFactory = (message: string) => Error;

export interface FalQueueTimings {
  submitSeconds: number;
  queueSeconds: number;
  totalSeconds: number;
  polls: number;
  /** Deepest fal queue position observed while polling; null when the job never reported one. */
  maxQueuePosition?: number | null;
}

export interface FalQueueJob {
  modelId: string;
  body: Record<string, unknown>;
}

export interface FalQueueRunOptions {
  apiKey: string;
  queueBaseUrl?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  makeError: FalErrorFactory;
}

export interface FalQueueOutcome<T> {
  requestId: string;
  result: T;
  timings: FalQueueTimings;
}

interface FalQueueHandle {
  request_id?: unknown;
  status_url?: unknown;
  response_url?: unknown;
}

interface FalStatus {
  status?: unknown;
  [key: string]: unknown;
}

export function elapsedSeconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) / 10) / 100;
}

export function requiredString(value: unknown, label: string, makeError: FalErrorFactory): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw makeError(`fal response is missing ${label}`);
  }
  return value;
}

export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException('Request aborted', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readFalJson<T>(response: Response, label: string, makeError: FalErrorFactory): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw makeError(`${label} failed (${response.status}): ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw makeError(`${label} returned invalid JSON`);
  }
}

async function readFalJsonWithRetry<T>(options: {
  url: string;
  headers: Record<string, string>;
  label: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  retryDelayMs: number;
  deadlineAt: number;
  timeoutError: () => Error;
  makeError: FalErrorFactory;
  maxRetries?: number | null;
}): Promise<T> {
  let retries = 0;
  const retriesExhausted = () =>
    options.maxRetries !== null && retries >= (options.maxRetries ?? MAX_READ_RETRIES);
  for (;;) {
    if (performance.now() >= options.deadlineAt) throw options.timeoutError();
    try {
      const response = await options.fetchImpl(options.url, {
        headers: options.headers,
        signal: options.signal,
      });
      if (response.ok || !RETRYABLE_READ_STATUSES.has(response.status) || retriesExhausted()) {
        return await readFalJson<T>(response, options.label, options.makeError);
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (!(error instanceof TypeError)) throw error;
      if (retriesExhausted()) {
        throw options.makeError(
          `${options.label} failed after ${retries + 1} transport attempts: ${error.message}`,
        );
      }
    }

    retries += 1;
    const remainingMs = options.deadlineAt - performance.now();
    if (remainingMs <= 0) throw options.timeoutError();
    const delayMs = Math.min(
      options.retryDelayMs * 2 ** (retries - 1),
      MAX_READ_RETRY_DELAY_MS,
      remainingMs,
    );
    await abortableDelay(delayMs, options.signal);
  }
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const code = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : null;
  return code ? `${error.message} (${code})` : error.message;
}

/**
 * fetch with bounded retries for the failures a busy queue produces: connection resets and
 * DNS blips (Node reports both as "fetch failed") and 5xx/429 responses. Eight or more clips
 * poll fal concurrently, so one transient error must not fence a whole run.
 */
async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
  makeError: FalErrorFactory,
  signal?: AbortSignal,
): Promise<Response> {
  let delay = FETCH_RETRY_BASE_MS;
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (attempt >= FETCH_ATTEMPTS) {
        throw makeError(`${label} failed after ${attempt} attempts: ${describeFetchError(error)}`);
      }
      await abortableDelay(delay, signal);
      delay = Math.min(delay * 2, 4_000);
      continue;
    }
    if (!TRANSIENT_HTTP_STATUSES.has(response.status) || attempt >= FETCH_ATTEMPTS) return response;
    await abortableDelay(delay, signal);
    delay = Math.min(delay * 2, 4_000);
  }
}

/**
 * Submit one job to the fal queue, poll it to completion, and return its parsed result.
 *
 * On abort before completion the queued request is cancelled best-effort so an abandoned run does
 * not keep paying; the original abort reason is preserved either way.
 */
export async function runFalQueueJob<T>(job: FalQueueJob, options: FalQueueRunOptions): Promise<FalQueueOutcome<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { makeError } = options;
  const queueBaseUrl = (options.queueBaseUrl ?? 'https://queue.fal.run').replace(/\/$/, '');
  const headers = {
    Authorization: `Key ${options.apiKey}`,
    'Content-Type': 'application/json',
  };
  const overallStartedAt = performance.now();
  const submitStartedAt = performance.now();
  let requestId: string | null = null;
  let completed = false;
  try {
    const submit = await fetchWithRetry(fetchImpl, `${queueBaseUrl}/${job.modelId}`, {
      method: 'POST',
      headers,
      signal: options.signal,
      body: JSON.stringify(job.body),
    }, 'fal submit', makeError, options.signal);
    const handle = await readFalJson<FalQueueHandle>(submit, 'fal submit', makeError);
    const submitSeconds = elapsedSeconds(submitStartedAt);
    requestId = requiredString(handle.request_id, 'request_id', makeError);
    const statusUrl =
      typeof handle.status_url === 'string'
        ? handle.status_url
        : `${queueBaseUrl}/${job.modelId}/requests/${requestId}/status`;
    const responseUrl =
      typeof handle.response_url === 'string'
        ? handle.response_url
        : `${queueBaseUrl}/${job.modelId}/requests/${requestId}`;

    const queueStartedAt = performance.now();
    let polls = 0;
    let maxQueuePosition: number | null = null;
    let lastStatus = '';
    const deadlineAt = overallStartedAt + options.timeoutMs;
    const timeoutError = () => makeError(
      `fal request ${requestId} timed out after ${Math.round(elapsedSeconds(overallStartedAt))}s`
        + ` (last status ${lastStatus || 'unknown'}, max queue position ${maxQueuePosition ?? 'n/a'})`,
    );
    const readOptions = {
      headers,
      fetchImpl,
      signal: options.signal,
      retryDelayMs: options.pollIntervalMs ?? 500,
      deadlineAt,
      timeoutError,
      makeError,
    };
    for (;;) {
      if (performance.now() >= deadlineAt) throw timeoutError();
      const statusBody = await readFalJsonWithRetry<FalStatus>({
        ...readOptions,
        url: statusUrl,
        label: 'fal status poll',
      });
      polls += 1;
      const status = typeof statusBody.status === 'string' ? statusBody.status : '';
      lastStatus = status;
      if (typeof statusBody.queue_position === 'number') {
        maxQueuePosition = Math.max(maxQueuePosition ?? 0, statusBody.queue_position);
      }
      if (status === 'COMPLETED') {
        completed = true;
        break;
      }
      if (TERMINAL_ERROR_STATUSES.has(status)) {
        throw makeError(`fal request ${requestId} ended ${status}`);
      }
      await abortableDelay(options.pollIntervalMs ?? 500, options.signal);
    }

    const result = await readFalJsonWithRetry<T>({
      ...readOptions,
      url: responseUrl,
      label: 'fal result fetch',
      // COMPLETED identifies an already-paid job whose result is safe to reread.
      // Keep recovering transient result-service failures until the generation deadline.
      maxRetries: null,
    });
    return {
      requestId,
      result,
      timings: {
        submitSeconds,
        queueSeconds: elapsedSeconds(queueStartedAt),
        totalSeconds: elapsedSeconds(overallStartedAt),
        polls,
        maxQueuePosition,
      },
    };
  } catch (error) {
    if (options.signal?.aborted && requestId && !completed) {
      try {
        await fetchImpl(`${queueBaseUrl}/${job.modelId}/requests/${requestId}/cancel`, {
          method: 'PUT',
          headers,
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Cancellation is best effort; preserve the original abort reason.
      }
    }
    throw error;
  }
}
