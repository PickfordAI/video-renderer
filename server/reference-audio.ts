import { execFile } from 'node:child_process';

import type { ReferenceAudioMetadata } from './generation-input.js';

const PADDED_REFERENCE_AUDIO_SECONDS = 2.1;
const MAX_PADDED_AUDIO_BYTES = 5 * 1024 * 1024;
const PAD_TIMEOUT_MS = 20_000;

interface PrepareReferenceAudioOptions {
  ffmpegPath?: string;
  padAudio?: (url: string) => Promise<string>;
}

function padAudioToDataUrl(audioUrl: string, ffmpegPath = 'ffmpeg'): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      audioUrl,
      '-af',
      `apad=whole_dur=${PADDED_REFERENCE_AUDIO_SECONDS}`,
      '-vn',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-f',
      'mp3',
      'pipe:1',
    ], {
      encoding: 'buffer',
      maxBuffer: MAX_PADDED_AUDIO_BYTES,
      timeout: PAD_TIMEOUT_MS,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = Buffer.from(stderr).toString('utf8').trim();
        reject(new Error(`could not normalize dialogue audio${detail ? `: ${detail.slice(0, 240)}` : ''}`));
        return;
      }
      const audio = Buffer.from(stdout);
      if (audio.length === 0) {
        reject(new Error('could not normalize dialogue audio: ffmpeg returned no audio'));
        return;
      }
      resolve(`data:audio/mpeg;base64,${audio.toString('base64')}`);
    });
  });
}

export async function prepareReferenceAudioUrls(
  audioUrls: string[] = [],
  metadata: ReferenceAudioMetadata[] = [],
  options: PrepareReferenceAudioOptions = {},
): Promise<string[]> {
  const padAudio = options.padAudio ?? ((url: string) => padAudioToDataUrl(url, options.ffmpegPath));
  return Promise.all(audioUrls.map(async (url, index) => {
    const reference = metadata[index];
    // fal measures the decoded media, which can be shorter than rounded or
    // missing DSS duration metadata. Normalize every exact performance so the
    // provider always receives at least 2.1 seconds. `whole_dur` does not trim
    // longer performances; canonical voice samples remain byte-for-byte intact.
    return reference?.role === 'dialogue_performance' ? padAudio(url) : url;
  }));
}
