import { execFile } from 'node:child_process';

/**
 * Reference images only need to be large enough to condition generation; the certified scene
 * PNGs arrive at up to 20 MB each. Downscaling once before the one-time storage upload cuts
 * the scene-boundary stall (download + upload of a new scene's assets) from tens of seconds
 * to a few, and keeps each request inside fal's free reference-token tier.
 */

const DEFAULT_MAX_EDGE = 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type ReferenceDownscaler = (
  bytes: Uint8Array,
  contentType: string,
  signal?: AbortSignal,
) => Promise<{ bytes: Uint8Array; contentType: string }>;

/** Longest edge for uploaded reference images; 0 disables downscaling. */
export function referenceMaxEdge(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.FAL_REFERENCE_MAX_EDGE ?? '', 10);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  return DEFAULT_MAX_EDGE;
}

export function ffmpegReferenceDownscaler(options: { ffmpegPath?: string; maxEdge?: number } = {}): ReferenceDownscaler {
  const maxEdge = options.maxEdge ?? referenceMaxEdge();
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  return (bytes, contentType, signal) => new Promise((resolve, reject) => {
    if (maxEdge <= 0) { resolve({ bytes, contentType }); return; }
    const child = execFile(ffmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-frames:v', '1',
      '-vf', `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`,
      '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1',
    ], { encoding: 'buffer', signal, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout) => {
      if (error) { reject(new Error('Could not downscale reference image', { cause: error })); return; }
      const out = Buffer.from(stdout);
      if (out.length < 3 || out[0] !== 0xff || out[1] !== 0xd8) { reject(new Error('Reference downscale returned no JPEG')); return; }
      resolve({ bytes: new Uint8Array(out), contentType: 'image/jpeg' });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(Buffer.from(bytes));
  });
}
