/** Provider choices shared by the studio and the server; contains no server secrets. */
export const RENDER_MODES = ['auto', 'fal-turbo-i2v', 'fal-max-ref2v'] as const;
export type RenderMode = typeof RENDER_MODES[number];

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
