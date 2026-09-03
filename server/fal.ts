const TERMINAL_ERROR_STATUSES = new Set(['ERROR', 'FAILED', 'CANCELLED']);

export interface GenerateVideoInput {
  prompt: string;
  duration: number;
  resolution: '480P' | '768P';
  aspectRatio: '16:9';
  referenceImageUrls?: string[];
  referenceAudioUrls?: string[];
}

export interface GenerateVideoResult {
  requestId: string;
  videoUrl: string;
  expandedPrompt: string | null;
  generationMode: 'text' | 'reference';
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
  const generationMode = input.referenceImageUrls?.length || input.referenceAudioUrls?.length ? 'reference' : 'text';
  const modelId = generationMode === 'reference'
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
        aspect_ratio: input.aspectRatio,
        prompt_expansion_mode: 'balanced',
        enable_safety_checker: true,
        ...(input.referenceImageUrls?.length ? { reference_image_urls: input.referenceImageUrls } : {}),
        ...(input.referenceAudioUrls?.length ? { reference_audio_urls: input.referenceAudioUrls } : {}),
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
    let polls = 0;
    for (;;) {
      if (performance.now() - overallStartedAt > timeoutMs) {
        throw new FalVideoError(`fal request ${requestId} timed out`);
      }
      const statusResponse = await fetchImpl(statusUrl, { headers, signal: options.signal });
      const statusBody = await readFalJson<FalStatus>(statusResponse, 'fal status poll');
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

    const resultResponse = await fetchImpl(responseUrl, { headers, signal: options.signal });
    const result = await readFalJson<FalResult>(resultResponse, 'fal result fetch');
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
        });
      } catch {
        // Cancellation is best effort; preserve the original abort reason.
      }
    }
    throw error;
  }
}
