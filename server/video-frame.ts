import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

/** Only fal output media is accepted; this must not become an arbitrary URL proxy. */
export function validateFrameVideoUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !(url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'))) {
    throw new Error('Frame extraction requires an HTTPS fal.media video URL');
  }
  return url.toString();
}

export async function extractVideoFrame(videoUrl: string, options: {
  position: 'first' | 'last';
  signal?: AbortSignal;
  ffmpegPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const source = validateFrameVideoUrl(videoUrl);
  if (options.position !== 'first' && options.position !== 'last') throw new Error('Frame position must be first or last');
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  const response = await (options.fetchImpl ?? fetch)(source, { signal, redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Could not download continuity video (${response.status})`);
  if (Number(response.headers.get('content-length')) > MAX_VIDEO_BYTES) {
    await response.body.cancel();
    throw new Error('Continuity video exceeds 80 MB');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_VIDEO_BYTES) throw new Error('Continuity video exceeds 80 MB');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'renderer-frame-'));
  try {
    const videoPath = join(directory, 'clip.mp4');
    await writeFile(videoPath, Buffer.concat(chunks), { signal });
    return await new Promise<string>((resolve, reject) => {
      execFile(options.ffmpegPath ?? 'ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        // Decode a local copy with external protocols disabled, including malicious playlists.
        '-protocol_whitelist', 'file,pipe',
        ...(options.position === 'last' ? ['-sseof', '-1'] : []),
        '-i', videoPath, '-frames:v', '1', '-an',
        '-vf', `${options.position === 'last' ? 'reverse,' : ''}scale=768:768:force_original_aspect_ratio=decrease`,
        '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', 'pipe:1',
      ], { encoding: 'buffer', signal, timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: MAX_FRAME_BYTES },
      (error, stdout) => {
        if (error) { reject(signal.aborted ? signal.reason : new Error('Could not extract continuity frame', { cause: error })); return; }
        const frame = Buffer.from(stdout);
        if (frame.length < 3 || frame[0] !== 0xff || frame[1] !== 0xd8 || frame[2] !== 0xff) {
          reject(new Error('Frame extraction returned no JPEG image')); return;
        }
        resolve(`data:image/jpeg;base64,${frame.toString('base64')}`);
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
