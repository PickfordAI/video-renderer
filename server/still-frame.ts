import { runFalQueueJob, type FalQueueTimings } from './fal-queue.js';
import { ffmpegReferenceDownscaler, type ReferenceDownscaler } from './image-downscale.js';
import { defaultRequestTimeoutMs } from './provider-timeouts.js';
import type { ReferenceUploader } from './fal-storage.js';

/**
 * PIC-1972: the still-image provider behind the `single-frame` render mode.
 *
 * FLUX.2 [klein] 4B is hard-coded here by decision (PIC-1927, 2026-09-14). Choosing the image
 * model per run belongs to Admin Model Preferences in phase 2, which is a Pickford-side surface
 * this standalone renderer cannot reach; pretending the choice is configurable now would invent a
 * knob with nothing behind it.
 */
/** Base model id, and the model identity the run's asset manifest registers. */
export const KLEIN_MODEL_FAMILY = 'fal-ai/flux-2/klein/4b';
export const KLEIN_TEXT_MODEL_ID = KLEIN_MODEL_FAMILY;
export const KLEIN_EDIT_MODEL_ID = `${KLEIN_MODEL_FAMILY}/edit`;
/** The edit endpoint accepts at most four reference images. */
export const MAX_STILL_REFERENCE_IMAGES = 4;
/** klein 4B's documented default; it is a distilled few-step model and gains little above this. */
const STILL_INFERENCE_STEPS = 4;
const MAX_REFERENCE_DOWNLOAD_BYTES = 32 * 1024 * 1024;

export class FalStillFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FalStillFrameError';
  }
}

const stillError = (message: string): Error => new FalStillFrameError(message);

export interface StillReference {
  name: string;
  url: string;
}

/**
 * Choose which references survive the edit endpoint's four-image limit.
 *
 * The planner emits `style, initial frame, …each character…, set`, so the set is **last**. Simply
 * keeping the first four therefore discards the environment as soon as four characters are staged
 * — the frame keeps every face and loses the room it is in. Identity and place are the two things
 * a still has to get right, so the speaker and the set are kept first and spare cast fill what is
 * left. A fourth character's portrait is worth less than the set the scene happens in.
 */
export function orderStillReferences(
  references: readonly StillReference[],
  speaker?: string,
  max: number = MAX_STILL_REFERENCE_IMAGES,
): StillReference[] {
  const taken = new Set<StillReference>();
  const ordered: StillReference[] = [];
  const take = (entry: StillReference | undefined): void => {
    if (!entry || taken.has(entry) || ordered.length >= max) return;
    taken.add(entry);
    ordered.push(entry);
  };
  take(speaker ? references.find(reference => reference.name === speaker) : undefined);
  take(references.find(reference => reference.name === 'set'));
  for (const reference of references) take(reference);
  return ordered;
}

export interface StillFrameInput {
  prompt: string;
  /** Ordered most- to least-important: speaker first, then other cast, then the set. */
  referenceImageUrls?: readonly string[];
  seed?: number;
}

export interface StillFrameOptions {
  apiKey: string;
  queueBaseUrl?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Uploads references fal cannot fetch itself. Omitted, references are passed through unchanged,
   * which is the existing `inline` scene-asset transport used by tests and storage-less providers.
   */
  referenceUploader?: ReferenceUploader;
  downscaler?: ReferenceDownscaler;
  /**
   * Per-run memo of reference URL to fal storage URL. Single Frame generates one image per line
   * against the same cast portraits, so without this every line re-uploads the same bytes.
   */
  uploadCache?: Map<string, Promise<string>>;
}

export interface StillFrameResult {
  imageUrl: string;
  /** As reported by fal; null when the response omits them. */
  width: number | null;
  height: number | null;
  requestId: string;
  timings: FalQueueTimings;
  modelId: string;
}

interface KleinImage {
  url?: unknown;
  width?: unknown;
  height?: unknown;
  content_type?: unknown;
}

interface KleinResult {
  images?: unknown;
  has_nsfw_concepts?: unknown;
  seed?: unknown;
  [key: string]: unknown;
}

/** fal fetches its own CDN directly; anything else has to be uploaded before it can be referenced. */
export function isFalHostedUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && (url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'));
}

function decodeDataUrl(value: string): { bytes: Uint8Array; contentType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  if (!match) return null;
  return { bytes: new Uint8Array(Buffer.from(match[2], 'base64')), contentType: match[1] };
}

async function downloadReference(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await fetchImpl(url, { redirect: 'follow', signal });
  if (!response.ok) throw new FalStillFrameError(`reference image download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new FalStillFrameError('reference image download returned an empty file');
  if (bytes.length > MAX_REFERENCE_DOWNLOAD_BYTES) {
    throw new FalStillFrameError(`reference image is larger than ${MAX_REFERENCE_DOWNLOAD_BYTES} bytes`);
  }
  return { bytes, contentType: response.headers.get('content-type') ?? 'image/jpeg' };
}

/**
 * Turn a planner reference into something fal's edit endpoint can fetch.
 *
 * The planner's references are fal.media URLs today, but PR #36 (PIC-1920) makes the scene-asset
 * cache hand back the original full-size data URL whenever a content hash is supplied, so this
 * must accept data URLs and foreign HTTPS URLs too.
 */
async function resolveReference(
  reference: string,
  options: StillFrameOptions,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (isFalHostedUrl(reference)) return reference;
  if (!options.referenceUploader) return reference;
  const cache = options.uploadCache;
  const cached = cache?.get(reference);
  if (cached) return cached;
  const upload = (async () => {
    const decoded = decodeDataUrl(reference);
    const source = decoded ?? await downloadReference(reference, fetchImpl, options.signal);
    const downscaler = options.downscaler ?? ffmpegReferenceDownscaler();
    const scaled = await downscaler(source.bytes, source.contentType, options.signal);
    const extension = scaled.contentType === 'image/png' ? 'png' : 'jpg';
    return options.referenceUploader!(scaled.bytes, scaled.contentType, `still-reference.${extension}`, options.signal);
  })();
  // Memoize the promise, not the result, so concurrent shots share one upload.
  cache?.set(reference, upload);
  try {
    return await upload;
  } catch (error) {
    cache?.delete(reference);
    throw error;
  }
}

function parseDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Generate one 16:9 still. Uses the edit endpoint when references exist so the frame inherits the
 * certified cast and set, and the text-to-image endpoint when a bundle has none.
 */
export async function generateStillFrame(
  input: StillFrameInput,
  options: StillFrameOptions,
): Promise<StillFrameResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // Callers should trim with `orderStillReferences`, which knows which entry is the set. This
  // slice is only a last-resort cap for callers that pass bare URLs.
  const requested = (input.referenceImageUrls ?? []).slice(0, MAX_STILL_REFERENCE_IMAGES);
  const imageUrls: string[] = [];
  for (const reference of requested) imageUrls.push(await resolveReference(reference, options, fetchImpl));
  const modelId = imageUrls.length ? KLEIN_EDIT_MODEL_ID : KLEIN_TEXT_MODEL_ID;

  const outcome = await runFalQueueJob<KleinResult>({
    modelId,
    body: {
      prompt: input.prompt,
      ...(imageUrls.length ? { image_urls: imageUrls } : {}),
      image_size: 'landscape_16_9',
      num_images: 1,
      num_inference_steps: STILL_INFERENCE_STEPS,
      output_format: 'jpeg',
      enable_safety_checker: true,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    },
  }, {
    apiKey: options.apiKey,
    queueBaseUrl: options.queueBaseUrl,
    fetchImpl,
    pollIntervalMs: options.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? defaultRequestTimeoutMs(),
    signal: options.signal,
    makeError: stillError,
  });

  const { result } = outcome;
  const flagged = Array.isArray(result.has_nsfw_concepts) && result.has_nsfw_concepts[0] === true;
  if (flagged) throw new FalStillFrameError(`fal request ${outcome.requestId} returned a frame flagged by the safety checker`);
  const images = Array.isArray(result.images) ? (result.images as KleinImage[]) : [];
  const image = images[0];
  if (!image || typeof image.url !== 'string' || image.url.length === 0) {
    throw new FalStillFrameError(`fal request ${outcome.requestId} returned no image`);
  }
  if (typeof image.content_type === 'string' && !image.content_type.startsWith('image/')) {
    throw new FalStillFrameError(`fal request ${outcome.requestId} returned ${image.content_type}, which is not an image`);
  }

  return {
    imageUrl: image.url,
    width: parseDimension(image.width),
    height: parseDimension(image.height),
    requestId: outcome.requestId,
    timings: outcome.timings,
    modelId,
  };
}
