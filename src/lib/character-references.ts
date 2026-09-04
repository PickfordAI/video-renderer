import type { CharacterReferenceMedia, CharacterReferenceSetting, StoryBeat } from './types';

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function containsName(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

function validSetting(value: unknown): CharacterReferenceSetting | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CharacterReferenceSetting>;
  if (typeof candidate.characterName !== 'string') return null;
  return {
    characterName: candidate.characterName,
    imageUrl: typeof candidate.imageUrl === 'string' ? candidate.imageUrl : '',
    audioUrl: typeof candidate.audioUrl === 'string' ? candidate.audioUrl : '',
  };
}

export function createDefaultCharacterReferences(): CharacterReferenceSetting[] {
  return [];
}

export function loadCharacterReferences(value: unknown, legacyImageUrls = ''): CharacterReferenceSetting[] {
  if (Array.isArray(value)) {
    return value.map(validSetting).filter((item): item is CharacterReferenceSetting => item !== null);
  }
  const references = createDefaultCharacterReferences();
  for (const rawLine of legacyImageUrls.split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const characterName = line.slice(0, separator).trim();
    const imageUrl = line.slice(separator + 1).trim();
    if (!characterName || !imageUrl.startsWith('https://')) continue;
    const existing = references.find((reference) => normalizeName(reference.characterName) === normalizeName(characterName));
    if (existing) existing.imageUrl = imageUrl;
    else references.push({ characterName, imageUrl, audioUrl: '' });
  }
  return references;
}

export function resolveCharacterReferences(
  beat: StoryBeat,
  configuredReferences: CharacterReferenceSetting[],
): CharacterReferenceMedia[] {
  const candidates = beat.characterNames?.length
    ? beat.characterNames
    : [
        ...configuredReferences
          .filter((reference) => containsName(beat.prompt, reference.characterName))
          .map((reference) => reference.characterName),
      ];
  const result: CharacterReferenceMedia[] = [];
  const emitted = new Set<string>();
  let mediaCount = 0;
  const canonicalSpeaker = beat.speakerName
    ? beat.speakerName.trim()
    : null;
  const speakerKey = canonicalSpeaker ? normalizeName(canonicalSpeaker) : null;

  for (const candidate of candidates) {
    const canonicalName = candidate.trim();
    const key = normalizeName(canonicalName);
    if (!canonicalName || emitted.has(key)) continue;
    const configured = configuredReferences.find((reference) => normalizeName(reference.characterName) === key);
    if (!configured) continue;
    const image = configured.imageUrl.trim().startsWith('https://') ? { imageUrl: configured.imageUrl.trim() } : {};
    const exactDialogueAudio = key === speakerKey && beat.dialogueAudioUrl?.startsWith('https://')
      ? beat.dialogueAudioUrl
      : undefined;
    const fallbackVoiceSample = key === speakerKey && configured.audioUrl.trim().startsWith('https://')
      ? configured.audioUrl.trim()
      : undefined;
    const audioUrl = exactDialogueAudio ?? fallbackVoiceSample;
    const audioRole = exactDialogueAudio ? 'dialogue_performance' : audioUrl ? 'voice_sample' : undefined;
    const referenceMediaCount = Number(Boolean(image.imageUrl)) + Number(Boolean(audioUrl));
    if (referenceMediaCount === 0 || mediaCount + referenceMediaCount > 12) continue;
    result.push({
      characterName: canonicalName,
      ...image,
      ...(audioUrl && audioRole ? {
        audioUrl,
        audioRole,
        ...(exactDialogueAudio && beat.dialogueAudioDurationSeconds !== undefined
          ? { audioDurationSeconds: beat.dialogueAudioDurationSeconds }
          : {}),
      } : {}),
    });
    mediaCount += referenceMediaCount;
    emitted.add(key);
  }
  return result;
}
