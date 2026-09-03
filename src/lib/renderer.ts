import { resolveCharacterReferences } from './character-references';
import type { CharacterReferenceMedia, GeneratedClip, RendererSettings, StoryBeat } from './types';

interface GenerateResponse {
  requestId: string;
  videoUrl: string;
  timings: { totalSeconds: number };
  generationMode?: 'text' | 'reference';
  error?: string;
}

export function buildRenderPrompt(
  beat: StoryBeat,
  durationSeconds: number,
  references: CharacterReferenceMedia[] = [],
): string {
  const imageReferences = references.filter((reference) => reference.assetKey || reference.imageUrl);
  const audioReferences = references.filter((reference) => reference.audioUrl);
  const imageDirection = imageReferences.length > 0
    ? `${imageReferences.map((reference, index) => `Image ${index + 1} is the canonical appearance of ${reference.characterName}.`).join(' ')} Preserve each referenced character's face, hair, age, wardrobe identity, and distinguishing features. Use the images as identity references, not as a required first frame.`
    : '';
  const audioDirection = audioReferences.length > 0
    ? audioReferences.map((reference, index) => reference.audioRole === 'dialogue_performance'
      ? `Audio ${index + 1} is ${reference.characterName}'s exact scripted dialogue performance. Preserve its words, timing, cadence, and vocal identity, and synchronize ${reference.characterName}'s lips precisely to it. Only ${reference.characterName} speaks in this shot.`
      : `Audio ${index + 1} is the canonical voice sample for ${reference.characterName}. Match its timbre, cadence, and vocal identity while performing only the scripted dialogue; never repeat or quote the reference sample's wording.`).join(' ')
    : '';
  const identityDirection = `${imageDirection} ${audioDirection}`.trim();
  return `${identityDirection} ${beat.prompt} Timing direction: Let this one focused moment unfold naturally across the full ${durationSeconds}-second shot. Do not rush through multiple actions or invent later events. Any spoken dialogue must use a natural conversational tempo, include comfortable pauses, and must never be sped up to fit.`.trim();
}

export async function renderBeat(
  beat: StoryBeat,
  settings: RendererSettings,
  signal?: AbortSignal,
): Promise<GeneratedClip> {
  const startedAt = performance.now();
  const durationSeconds = beat.durationSeconds ?? settings.duration;
  const references = settings.useCharacterReferences
    ? resolveCharacterReferences(beat, settings.characterReferences)
    : [];
  const prompt = buildRenderPrompt(beat, durationSeconds, references);
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      prompt,
      duration: durationSeconds,
      resolution: settings.resolution,
      characterReferences: references,
    }),
  });
  const result = (await response.json()) as GenerateResponse;
  if (!response.ok) throw new Error(result.error ?? `Renderer failed (${response.status})`);
  return {
    id: `${beat.storyBlockId}:${result.requestId}`,
    storyBlockId: beat.storyBlockId,
    prompt,
    videoUrl: result.videoUrl,
    requestId: result.requestId,
    createdAt: Date.now(),
    durationSeconds,
    totalSeconds: result.timings.totalSeconds,
    generationMs: Math.max(0, performance.now() - startedAt),
    generationMode: result.generationMode ?? (references.length > 0 ? 'reference' : 'text'),
    referenceCharacters: references.map((reference) => reference.characterName),
  };
}
