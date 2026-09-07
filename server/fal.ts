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
}

export interface GenerateVideoResult {
  requestId: string;
  videoUrl: string;
  expandedPrompt: string | null;
  generationMode: 'text' | 'reference' | 'image';
  timings: {
    submitSeconds: number;
    queueSeconds: number;
    totalSeconds: number;
    polls: number;
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
}): Promise<T> {
  let retries = 0;
  for (;;) {
    if (performance.now() >= options.deadlineAt) throw options.timeoutError();
    try {
      const response = await options.fetchImpl(options.url, {
        headers: options.headers,
        signal: options.signal,
      });
      if (response.ok || !RETRYABLE_READ_STATUSES.has(response.status) || retries >= MAX_READ_RETRIES) {
        return await readFalJson<T>(response, options.label);
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (!(error instanceof TypeError)) throw error;
      if (retries >= MAX_READ_RETRIES) {
        throw new FalVideoError(
          `${options.label} failed after ${MAX_READ_RETRIES + 1} transport attempts: ${error.message}`,
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
  if (renderMode !== 'fal-turbo-i2v' && imageUrls.length + audioUrls.length > 12) {
    throw new FalVideoError('Reference inputs exceed the image/audio limits');
  }
  if (renderMode !== 'fal-turbo-i2v' && audioUrls.length && !imageUrls.length) {
    throw new FalVideoError('Audio references require at least one image reference');
  }
  const generationMode: GenerateVideoResult['generationMode'] = renderMode === 'fal-turbo-i2v'
    ? 'image'
    : renderMode === 'fal-max-ref2v' || imageUrls.length || audioUrls.length ? 'reference' : 'text';
  const modelId = renderMode === 'fal-turbo-i2v'
    ? 'minimax/h3-max-turbo/image-to-video'
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
    const submit = await fetchImpl(`${queueBaseUrl}/${modelId}`, {
      method: 'POST',
      headers,
      signal: options.signal,
      body: JSON.stringify({
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
    });
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
    const timeoutMs = options.timeoutMs ?? 180_000;
    const deadlineAt = overallStartedAt + timeoutMs;
    const timeoutError = () => new FalVideoError(`fal request ${requestId} timed out`);
    const readOptions = {
      headers,
      fetchImpl,
      signal: options.signal,
      retryDelayMs: options.pollIntervalMs ?? 500,
      deadlineAt,
      timeoutError,
    };
    let polls = 0;
    for (;;) {
      if (performance.now() >= deadlineAt) throw timeoutError();
      const statusBody = await readFalJsonWithRetry<FalStatus>({
        ...readOptions,
        url: statusUrl,
        label: 'fal status poll',
      });
      polls += 1;
      const status = typeof statusBody.status === 'string' ? statusBody.status : '';
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
