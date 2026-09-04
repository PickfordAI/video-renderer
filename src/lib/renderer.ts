import type { RenderMode } from '../../server/render-mode';
import { resolveCharacterReferences } from './character-references';
import type { CharacterReferenceMedia, GeneratedClip, RendererSettings, StoryBeat } from './types';

interface GenerateResponse {
  requestId: string;
  videoUrl: string;
  timings: { totalSeconds: number };
  generationMode?: 'text' | 'reference' | 'image';
  error?: string;
}

export function buildRenderPrompt(
  beat: StoryBeat,
  durationSeconds: number,
  references: CharacterReferenceMedia[] = [],
  mode: RenderMode = 'auto',
): string {
  if (mode === 'fal-turbo-i2v') references = [];

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
  return `${mode === 'fal-turbo-i2v' ? 'Continue from the supplied initial image. Preserve the visible character designs, set, lighting, and staging.' : identityDirection} ${beat.prompt} Timing direction: Let this one focused moment unfold naturally across the full ${durationSeconds}-second shot. Do not rush through multiple actions or invent later events. Any spoken dialogue must use a natural conversational tempo, include comfortable pauses, and must never be sped up to fit.`.trim();
}

export async function renderBeat(
  beat: StoryBeat,
  settings: RendererSettings,
  signal?: AbortSignal,
  initialImageUrl = settings.initialImageUrl,
): Promise<GeneratedClip> {
  const startedAt = performance.now();
  const durationSeconds = beat.durationSeconds ?? settings.duration;
  const mode = settings.renderMode ?? 'auto';
  const references = mode !== 'fal-turbo-i2v' && (settings.useCharacterReferences || mode === 'fal-max-ref2v')
    ? resolveCharacterReferences(beat, settings.characterReferences.map(reference => mode === 'fal-max-ref2v' && !(reference.audioDurationSeconds !== undefined && reference.audioDurationSeconds >= 2 && reference.audioDurationSeconds <= 15)
      ? { ...reference, audioUrl: '' } : reference))
    : [];
  if (mode === 'fal-turbo-i2v' && !initialImageUrl) throw new Error('Turbo requires an initial scene image.');
  if (mode === 'fal-max-ref2v' && !initialImageUrl && !references.some(reference => reference.imageUrl || reference.assetKey)) throw new Error('No image reference matches this shot. Add a named character image or an initial scene image.');
  const descriptions = (settings.characterReferences ?? []).filter(reference => references.some(item => item.characterName === reference.characterName) && reference.description?.trim())
    .map(reference => `${reference.characterName}: ${reference.description?.trim()}`).join(' ');
  const sceneReference = mode === 'fal-max-ref2v' && initialImageUrl
    ? `Image ${references.filter(reference => reference.imageUrl || reference.assetKey).length + 1} is the scene continuity reference. Preserve its set, lighting, and spatial layout.` : '';
  const prompt = buildRenderPrompt({ ...beat, prompt: [settings.styleDescription, descriptions, sceneReference, beat.prompt].filter(Boolean).join(' ') }, durationSeconds, references, mode);
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      prompt,
      renderMode: mode,
      initialImageUrl: initialImageUrl || undefined,
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
    generationMode: result.generationMode ?? (mode === 'fal-turbo-i2v' ? 'image' : references.length > 0 || mode === 'fal-max-ref2v' ? 'reference' : 'text'),
    referenceCharacters: references.map((reference) => reference.characterName),
  };
}

/** One session owns the Turbo chain. Callers serialize Turbo jobs and reset on Stop. */
export class StudioRenderSession {
  private previousVideoUrl: string | null = null;
  private epoch = 0;
  private activeTurboEpoch: number | null = null;

  reset(): void {
    this.epoch += 1;
    this.previousVideoUrl = null;
  }

  async render(beat: StoryBeat, settings: RendererSettings, signal: AbortSignal): Promise<GeneratedClip> {
    const epoch = this.epoch;
    const turbo = settings.renderMode === 'fal-turbo-i2v';
    if (turbo) {
      if (this.activeTurboEpoch === epoch) throw new Error('A Turbo continuity shot is already generating.');
      this.activeTurboEpoch = epoch;
    }
    try { return await this.renderNext(beat, settings, signal); }
    finally { if (turbo && this.activeTurboEpoch === epoch) this.activeTurboEpoch = null; }
  }

  private async renderNext(beat: StoryBeat, settings: RendererSettings, signal: AbortSignal): Promise<GeneratedClip> {
    const epoch = this.epoch;
    let imageUrl = settings.initialImageUrl;
    if (settings.renderMode === 'fal-turbo-i2v' && this.previousVideoUrl) {
      const response = await fetch('/api/video-frame', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ videoUrl: this.previousVideoUrl, position: 'last' }),
      });
      const body = await response.json() as { imageUrl?: string; error?: string };
      if (!response.ok || !body.imageUrl) throw new Error(body.error ?? 'Could not prepare the next continuity frame.');
      imageUrl = body.imageUrl;
    }
    if (signal.aborted || epoch !== this.epoch) throw new DOMException('Rendering stopped', 'AbortError');
    const clip = await renderBeat(beat, settings, signal, imageUrl);
    if (signal.aborted || epoch !== this.epoch) throw new DOMException('Rendering stopped', 'AbortError');
    if (settings.renderMode === 'fal-turbo-i2v') this.previousVideoUrl = clip.videoUrl;
    return clip;
  }
}
