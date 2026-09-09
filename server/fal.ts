import { defaultRequestTimeoutMs } from './provider-timeouts.js';
import { parseRenderMode, type RenderMode } from './render-mode.js';

const TERMINAL_ERROR_STATUSES = new Set(['ERROR', 'FAILED', 'CANCELLED']);
const RETRYABLE_READ_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_READ_RETRIES = 5;
const MAX_READ_RETRY_DELAY_MS = 5_000;

export interface GenerateVideoInput {
  prompt: string;
  duration: number;
  resolution: '480P' | '768P';
  aspectRatio: '16:9';
  referenceImageUrls?: string[];
  referenceAudioUrls?: string[];
  renderMode?: RenderMode;
  /** Explicit first frame, including an internally extracted continuity frame. */
  initialImageUrl?: string;
  /** PIC-1832: LoRA weights applied by the WhispMax text-to-video endpoint. */
  loras?: ReadonlyArray<{ path: string; scale: number }>;
  /** Fixed seed for reproducible takes; the WhispMax mode records one per clip in its plan. */
  seed?: number;
}

export interface GenerateVideoResult {
  requestId: string;
  videoUrl: string;
  expandedPrompt: string | null;
  generationMode: 'text' | 'reference' | 'image' | 'lora';
  timings: {
    submitSeconds: number;
    queueSeconds: number;
    totalSeconds: number;
    polls: number;
    /** Deepest fal queue position observed while polling; null when the job never reported one. */
    maxQueuePosition?: number | null;
  };
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

interface FalResult {
  video?: { url?: unknown };
  expanded_prompt?: unknown;
  [key: string]: unknown;
}

export class FalVideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FalVideoError';
  }
}

function elapsedSeconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) / 10) / 100;
}

async function readFalJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new FalVideoError(`${label} failed (${response.status}): ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FalVideoError(`${label} returned invalid JSON`);
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
  timeoutError: () => FalVideoError;
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
        return await readFalJson<T>(response, options.label);
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (!(error instanceof TypeError)) throw error;
      if (retriesExhausted()) {
        throw new FalVideoError(
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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FalVideoError(`fal response is missing ${label}`);
  }
  return value;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
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

// Provider statuses worth one more try. 4xx other than these are the caller's fault and
// would fail identically on retry; success and non-listed statuses return to the caller.
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const FETCH_ATTEMPTS = 4;
const FETCH_RETRY_BASE_MS = 500;

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
        throw new FalVideoError(`${label} failed after ${attempt} attempts: ${describeFetchError(error)}`);
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

export async function generateVideo(
  input: GenerateVideoInput,
  options: {
    apiKey: string;
    modelId?: string;
    referenceModelId?: string;
    queueBaseUrl?: string;
    fetchImpl?: typeof fetch;
    pollIntervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<GenerateVideoResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const renderMode = parseRenderMode(input.renderMode);
  const imageUrls = [...(input.referenceImageUrls ?? [])];
  if (renderMode === 'fal-max-ref2v' && input.initialImageUrl && !imageUrls.includes(input.initialImageUrl)) {
    imageUrls.push(input.initialImageUrl);
  }
  const audioUrls = (input.referenceAudioUrls ?? []).map(url => url.replace(/^data:audio\/mpeg;/, 'data:audio/mp3;'));
  if (renderMode === 'fal-turbo-i2v' && !input.initialImageUrl) {
    throw new FalVideoError('H3 Max Turbo image-to-video requires an initial image or a previous clip frame');
  }
  if (renderMode === 'fal-max-ref2v' && imageUrls.length === 0) {
    throw new FalVideoError('H3 Max reference-to-video requires a character, scene, or camera reference image');
  }
  if (renderMode === 'whispmax-t2v') {
    if (!input.loras?.length) throw new FalVideoError('whispmax-t2v requires the WhispMax LoRA weights');
    if (imageUrls.length) throw new FalVideoError('whispmax-t2v is text-to-video; it takes no image references');
    if (!Number.isInteger(input.duration) || input.duration < 5 || input.duration > 15) {
      throw new FalVideoError('whispmax-t2v duration must be an integer from 5 to 15 seconds');
    }
  }
  if (renderMode !== 'fal-turbo-i2v' && renderMode !== 'whispmax-t2v' && imageUrls.length + audioUrls.length > 12) {
    throw new FalVideoError('Reference inputs exceed the image/audio limits');
  }
  if (renderMode !== 'fal-turbo-i2v' && renderMode !== 'whispmax-t2v' && audioUrls.length && !imageUrls.length) {
    throw new FalVideoError('Audio references require at least one image reference');
  }
  const generationMode: GenerateVideoResult['generationMode'] = renderMode === 'fal-turbo-i2v'
    ? 'image'
    : renderMode === 'whispmax-t2v'
      ? 'lora'
      : renderMode === 'fal-max-ref2v' || imageUrls.length || audioUrls.length ? 'reference' : 'text';
  const modelId = renderMode === 'fal-turbo-i2v'
    ? 'minimax/h3-max-turbo/image-to-video'
    : renderMode === 'whispmax-t2v'
      ? 'minimax/h3-max/text-to-video/lora'
      : renderMode === 'fal-max-ref2v'
        ? 'minimax/h3-max/reference-to-video'
        : generationMode === 'reference'
          ? options.referenceModelId ?? 'minimax/h3-max/reference-to-video'
          : options.modelId ?? 'minimax/h3-max-turbo/text-to-video';
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
    const submit = await fetchWithRetry(fetchImpl, `${queueBaseUrl}/${modelId}`, {
      method: 'POST',
      headers,
      signal: options.signal,
      body: JSON.stringify(generationMode === 'lora'
        // The LoRA endpoint takes the WhispMax prompt as written; prompt expansion would
        // rewrite the trained caption structure the weights depend on.
        ? {
            prompt: input.prompt,
            loras: input.loras,
            duration: input.duration,
            aspect_ratio: input.aspectRatio,
            resolution: input.resolution,
            ...(input.seed === undefined ? {} : { seed: input.seed }),
            ...(audioUrls.length ? { reference_audio_urls: audioUrls } : {}),
          }
        : {
            prompt: input.prompt,
            duration: input.duration,
            resolution: input.resolution,
            ...(generationMode !== 'image' ? { aspect_ratio: input.aspectRatio } : {}),
            prompt_expansion_mode: 'balanced',
            enable_safety_checker: true,
            ...(generationMode === 'image'
              ? { image_url: input.initialImageUrl }
              : {
                  ...(imageUrls.length ? { reference_image_urls: imageUrls } : {}),
                  ...(audioUrls.length ? { reference_audio_urls: audioUrls } : {}),
                }),
          }),
    }, 'fal submit', options.signal);
    const handle = await readFalJson<FalQueueHandle>(submit, 'fal submit');
    const submitSeconds = elapsedSeconds(submitStartedAt);
    requestId = requiredString(handle.request_id, 'request_id');
    const statusUrl =
      typeof handle.status_url === 'string'
        ? handle.status_url
        : `${queueBaseUrl}/${modelId}/requests/${requestId}/status`;
    const responseUrl =
      typeof handle.response_url === 'string'
        ? handle.response_url
        : `${queueBaseUrl}/${modelId}/requests/${requestId}`;

    const queueStartedAt = performance.now();
    let polls = 0;
    let maxQueuePosition: number | null = null;
    let lastStatus = '';
    const timeoutMs = options.timeoutMs ?? defaultRequestTimeoutMs();
    const deadlineAt = overallStartedAt + timeoutMs;
    const timeoutError = () => new FalVideoError(
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
        throw new FalVideoError(`fal request ${requestId} ended ${status}`);
      }
      await abortableDelay(options.pollIntervalMs ?? 500, options.signal);
    }

    const result = await readFalJsonWithRetry<FalResult>({
      ...readOptions,
      url: responseUrl,
      label: 'fal result fetch',
      // COMPLETED identifies an already-paid job whose result is safe to reread.
      // Keep recovering transient result-service failures until the generation deadline.
      maxRetries: null,
    });
    const videoUrl = requiredString(result.video?.url, 'video.url');
    return {
      requestId,
      videoUrl,
      expandedPrompt: typeof result.expanded_prompt === 'string' ? result.expanded_prompt : null,
      generationMode,
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
        await fetchImpl(`${queueBaseUrl}/${modelId}/requests/${requestId}/cancel`, {
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
