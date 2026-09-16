import { runFalQueueJob, requiredString, type FalQueueTimings } from './fal-queue.js';
import { defaultRequestTimeoutMs } from './provider-timeouts.js';
import { parseRenderMode, type RenderMode } from './render-mode.js';

export interface GenerateVideoInput {
  prompt: string;
  duration: number;
  resolution: '480P' | '768P';
  aspectRatio: '16:9';
  promptExpansionMode?: 'disabled' | 'balanced' | 'quality';
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
  timings: FalQueueTimings;
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

const videoError = (message: string): Error => new FalVideoError(message);

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
  const renderMode = parseRenderMode(input.renderMode);
  // PIC-1971: this module submits video jobs only. `single-frame` must never fall through to the
  // text-to-video default, which would silently pay for a video clip the mode never asked for.
  if (renderMode === 'single-frame') {
    throw new FalVideoError('single-frame rendering is not wired to a provider yet');
  }
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

  const outcome = await runFalQueueJob<FalResult>({
    modelId,
    body: {
      prompt: input.prompt,
      duration: input.duration,
      resolution: input.resolution,
      ...(generationMode !== 'image' ? { aspect_ratio: input.aspectRatio } : {}),
      prompt_expansion_mode: input.promptExpansionMode ?? 'balanced',
      enable_safety_checker: true,
      ...(generationMode === 'image'
        ? { image_url: input.initialImageUrl }
        : {
            ...(imageUrls.length ? { reference_image_urls: imageUrls } : {}),
            ...(audioUrls.length ? { reference_audio_urls: audioUrls } : {}),
          }),
    },
  }, {
    apiKey: options.apiKey,
    queueBaseUrl: options.queueBaseUrl,
    fetchImpl: options.fetchImpl,
    pollIntervalMs: options.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? defaultRequestTimeoutMs(),
    signal: options.signal,
    makeError: videoError,
  });

  return {
    requestId: outcome.requestId,
    videoUrl: requiredString(outcome.result.video?.url, 'video.url', videoError),
    expandedPrompt: typeof outcome.result.expanded_prompt === 'string' ? outcome.result.expanded_prompt : null,
    generationMode,
    timings: outcome.timings,
  };
}
