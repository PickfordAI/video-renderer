import type { GenerateVideoInput } from './fal.js';
import { parseInitialImageUrl, parseRendererConfig } from './render-mode.js';

export interface ReferenceAudioMetadata {
  role?: 'voice_sample' | 'dialogue_performance';
  durationSeconds?: number;
}

export interface ParsedGenerateVideoInput extends GenerateVideoInput {
  referenceAudioMetadata: ReferenceAudioMetadata[];
}

export function parseGenerationInput(
  value: unknown,
  resolveReferenceAsset: (assetKey: string) => string,
): ParsedGenerateVideoInput {
  if (!value || typeof value !== 'object') throw new Error('request body must be an object');
  const body = value as Record<string, unknown>;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length < 12 || prompt.length > 3000) {
    throw new Error('prompt must contain 12–3000 characters');
  }
  const duration = typeof body.duration === 'number' ? body.duration : 5;
  if (!Number.isInteger(duration) || duration < 5 || duration > 15) {
    throw new Error('duration must be an integer from 5 to 15 seconds');
  }
  const resolution = body.resolution === '480P' ? '480P' : '768P';
  const renderMode = parseRendererConfig(body.rendererConfig, { renderMode: body.renderMode }).model;
  const initialImageUrl = parseInitialImageUrl(body.initialImageUrl, true);
  if (renderMode === 'fal-turbo-i2v' && !initialImageUrl) {
    throw new Error('H3 Max Turbo image-to-video requires an initial image');
  }
  const referenceMedia = parseReferenceMedia(
    body.characterReferences ?? body.referenceImages,
    resolveReferenceAsset,
  );
  return {
    prompt,
    duration,
    resolution,
    aspectRatio: '16:9',
    renderMode,
    initialImageUrl,
    referenceImageUrls: referenceMedia.imageUrls,
    referenceAudioUrls: referenceMedia.audioUrls,
    referenceAudioMetadata: referenceMedia.audioMetadata,
  };
}

function parseReferenceMedia(
  value: unknown,
  resolveReferenceAsset: (assetKey: string) => string,
): { imageUrls: string[]; audioUrls: string[]; audioMetadata: ReferenceAudioMetadata[] } {
  if (value === undefined) return { imageUrls: [], audioUrls: [], audioMetadata: [] };
  if (!Array.isArray(value) || value.length > 12) {
    throw new Error('characterReferences must be an array containing at most 12 entries');
  }
  const imageUrls: string[] = [];
  const audioUrls: string[] = [];
  const audioMetadata: ReferenceAudioMetadata[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new Error('each character reference must be an object');
    const reference = item as Record<string, unknown>;
    if (typeof reference.assetKey === 'string') imageUrls.push(resolveReferenceAsset(reference.assetKey));
    else if (typeof reference.imageUrl === 'string') {
      if (!reference.imageUrl.startsWith('https://')) {
        throw new Error('each external image reference must use an HTTPS URL');
      }
      imageUrls.push(reference.imageUrl);
    }
    if (typeof reference.audioUrl === 'string') {
      if (!reference.audioUrl.startsWith('https://')) {
        throw new Error('each audio reference must use an HTTPS URL');
      }
      audioUrls.push(reference.audioUrl);
      const durationSeconds = typeof reference.audioDurationSeconds === 'number'
        && Number.isFinite(reference.audioDurationSeconds)
        && reference.audioDurationSeconds > 0
        ? reference.audioDurationSeconds
        : undefined;
      const role = reference.audioRole === 'dialogue_performance' || reference.audioRole === 'voice_sample'
        ? reference.audioRole
        : undefined;
      audioMetadata.push({
        ...(role ? { role } : {}),
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      });
    }
    if (typeof reference.assetKey !== 'string' && typeof reference.imageUrl !== 'string' && typeof reference.audioUrl !== 'string') {
      throw new Error('each character reference must contain image or audio media');
    }
  }
  if (imageUrls.length + audioUrls.length > 12) {
    throw new Error('character references may contain at most 12 image and audio assets in total');
  }
  return { imageUrls, audioUrls, audioMetadata };
}
