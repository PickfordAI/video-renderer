import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Preserve both selected streams, rounding up to the publisher's 24-fps clock. */
export async function probeClipDurationSeconds(path: string): Promise<number> {
  const { stdout } = await execFileAsync(process.env.FFPROBE_PATH ?? 'ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_entries', 'stream=codec_type,duration:format=duration', '-of', 'json', path,
  ], { timeout: 20_000, maxBuffer: 64 * 1024 });
  return measuredClipDurationSeconds(JSON.parse(stdout));
}

interface ClipDurationMetadata {
  streams?: Array<{ codec_type?: string; duration?: string }>;
  format?: { duration?: string };
}

export function measuredClipDurationSeconds({ streams, format }: ClipDurationMetadata): number {
  const video = streams?.find(stream => stream.codec_type === 'video');
  const audio = streams?.find(stream => stream.codec_type === 'audio');
  if (!video) throw new Error('Generated clip has no video stream');
  const durations = [video, ...(audio ? [audio] : [])].map(stream => {
    const duration = Number(stream.duration);
    // Some muxers expose duration only on the container, including fragmented MP4.
    return Number.isFinite(duration) && duration > 0 ? duration : Number(format?.duration);
  });
  if (durations.some(duration => !Number.isFinite(duration) || duration <= 0)) {
    throw new Error('Generated clip has no measurable audio/video duration');
  }
  return Math.ceil(Math.max(...durations) * 24) / 24;
}
