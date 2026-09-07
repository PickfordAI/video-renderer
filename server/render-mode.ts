/** Provider choices and continuity capabilities for private renderer configuration. */
export const RENDER_MODES = ['auto', 'fal-turbo-i2v', 'fal-max-ref2v'] as const;
export type RenderMode = typeof RENDER_MODES[number];

/**
 * Upper bounds on paid-work scheduling. Provider queues, not this renderer, are the practical limit,
 * so these caps exist to catch typos rather than to size a run: the sweep harness measures the
 * real ceiling per provider and the README records the defaults that came out of it.
 */
export const MAX_CONCURRENCY = 32;
export const MAX_BUFFERED_SECONDS = 150;

export type ContinuityStrategy = 'none' | 'last-frame-chain' | 'camera-anchors';
export interface RendererConfig {
  model: RenderMode;
  continuity: ContinuityStrategy;
  concurrency: number;
  maxBufferedSeconds: number;
}

/** Capability validation is separate from the scheduler's strategy implementation. */
export const SUPPORTED_CONTINUITY: Readonly<Record<RenderMode, readonly ContinuityStrategy[]>> = {
  auto: ['none'],
  'fal-turbo-i2v': ['last-frame-chain'],
  'fal-max-ref2v': ['none', 'camera-anchors'],
};

export function defaultContinuity(model: RenderMode): ContinuityStrategy {
  return model === 'fal-turbo-i2v' ? 'last-frame-chain' : model === 'fal-max-ref2v' ? 'camera-anchors' : 'none';
}

/** Old handoffs retain their behavior; new callers can select each policy explicitly. */
export function parseRendererConfig(value: unknown, legacy: {
  renderMode?: unknown; generationConcurrency?: unknown; maxBufferedSeconds?: unknown;
} = {}): RendererConfig {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('rendererConfig must be an object');
  }
  const config = (value ?? {}) as Record<string, unknown>;
  const model = parseRenderMode(config.model ?? legacy.renderMode);
  const continuity = config.continuity ?? defaultContinuity(model);
  if (!['none', 'last-frame-chain', 'camera-anchors'].includes(continuity as string)) {
    throw new Error('rendererConfig.continuity must be none, last-frame-chain, or camera-anchors');
  }
  if (!SUPPORTED_CONTINUITY[model].includes(continuity as ContinuityStrategy)) {
    throw new Error(`${model} does not yet support the ${continuity} continuity strategy`);
  }
  const concurrency = config.concurrency ?? legacy.generationConcurrency ?? 2;
  const maxBufferedSeconds = config.maxBufferedSeconds ?? legacy.maxBufferedSeconds ?? 30;
  if (!Number.isInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > MAX_CONCURRENCY) {
    throw new Error('rendererConfig.concurrency must be an integer from 1 to ' + MAX_CONCURRENCY);
  }
  if (!Number.isInteger(maxBufferedSeconds) || (maxBufferedSeconds as number) < 5 || (maxBufferedSeconds as number) > MAX_BUFFERED_SECONDS) {
    throw new Error('rendererConfig.maxBufferedSeconds must be an integer from 5 to ' + MAX_BUFFERED_SECONDS);
  }
  return { model, continuity: continuity as ContinuityStrategy, concurrency: concurrency as number, maxBufferedSeconds: maxBufferedSeconds as number };
}

export const RENDER_MODE_LABELS: Record<RenderMode, string> = {
  auto: 'Configured provider',
  'fal-turbo-i2v': 'H3 Max Turbo · image to video',
  'fal-max-ref2v': 'H3 Max · reference to video',
};

export function parseRenderMode(value: unknown): RenderMode {
  if (value === undefined) return 'auto';
  if (typeof value === 'string' && RENDER_MODES.some(mode => mode === value)) return value as RenderMode;
  throw new Error('renderMode must be auto, fal-turbo-i2v, or fal-max-ref2v');
}

export function parseInitialImageUrl(value: unknown, allowInlineFrame = false): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('initialImageUrl must be an HTTPS URL');
  if (allowInlineFrame && value.length <= 1_400_000 && /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('initialImageUrl must be an HTTPS URL without credentials');
  }
  return url.toString();
}
