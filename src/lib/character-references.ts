import type { CharacterReferenceMedia, CharacterReferenceSetting, StoryBeat } from './types';

interface BuiltInCharacterReference extends CharacterReferenceSetting {
  aliases: string[];
}

const VOICE_PREVIEW_ROOT =
  'https://storage.googleapis.com/stoked-genius-449903-r6-dev-public-assets/voice-previews/audio';

export const DEFAULT_CHARACTER_REFERENCES: BuiltInCharacterReference[] = [
  {
    characterName: 'Marcus Kent',
    imageUrl: '/reference-assets/whispers/kent.jpg',
    audioUrl: `${VOICE_PREVIEW_ROOT}/kent-4328b029a621ff84.mp3`,
    aliases: ['Marcus', 'Kent'],
  },
  {
    characterName: 'Nathan Paulson',
    imageUrl: '/reference-assets/whispers/nathan.jpg',
    audioUrl: `${VOICE_PREVIEW_ROOT}/nathan-b8ff52aba7006bb6.mp3`,
    aliases: ['Nathan', 'Paulson', 'Nathan Brooks', 'Brooks'],
  },
  {
    characterName: 'Richard Cho',
    imageUrl: '/reference-assets/whispers/richard.jpg',
    audioUrl: `${VOICE_PREVIEW_ROOT}/richard-c6632b9f42086088.mp3`,
    aliases: ['Richard', 'Cho', 'Richard Vance', 'Vance'],
  },
  {
    characterName: 'Cassandra Vexon',
    imageUrl: '/reference-assets/whispers/cassandra.jpg',
    audioUrl: `${VOICE_PREVIEW_ROOT}/cassandra-37657c49f4ed66b6.mp3`,
    aliases: ['Cassandra', 'Vexon', 'Cassandra Wells', 'Wells'],
  },
  {
    characterName: 'June Morrison',
    imageUrl: '/reference-assets/whispers/june.jpg',
    audioUrl: `${VOICE_PREVIEW_ROOT}/june-eb0539760d654ee8.mp3`,
    aliases: ['June', 'Morrison'],
  },
  {
    characterName: 'Lily Song',
    imageUrl: '/reference-assets/whispers/song.jpg',
    audioUrl: `${VOICE_PREVIEW_ROOT}/song-0853e82a63cb152a.mp3`,
    aliases: ['Lily', 'Song'],
  },
  {
    characterName: 'Autumn Tate',
    imageUrl: '/reference-assets/whispers/autumn.jpg',
    audioUrl: `${VOICE_PREVIEW_ROOT}/autumn-9fb1d00201b97d56.mp3`,
    aliases: ['Autumn', 'Tate'],
  },
];

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
  return DEFAULT_CHARACTER_REFERENCES.map(({ characterName, imageUrl, audioUrl }) => ({
    characterName,
    imageUrl,
    audioUrl,
  }));
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

function builtInForName(name: string): BuiltInCharacterReference | null {
  const normalized = normalizeName(name);
  return DEFAULT_CHARACTER_REFERENCES.find((reference) =>
    [reference.characterName, ...reference.aliases].some((candidate) => normalizeName(candidate) === normalized),
  ) ?? null;
}

function imageSource(value: string): Pick<CharacterReferenceMedia, 'assetKey' | 'imageUrl'> {
  const localPrefix = '/reference-assets/';
  if (value.startsWith(localPrefix)) return { assetKey: value.slice(localPrefix.length) };
  if (value.startsWith('https://')) return { imageUrl: value };
  return {};
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
        ...DEFAULT_CHARACTER_REFERENCES
          .filter((reference) => reference.aliases.some((name) => containsName(beat.prompt, name)))
          .map((reference) => reference.characterName),
      ];
  const result: CharacterReferenceMedia[] = [];
  const emitted = new Set<string>();
  let mediaCount = 0;
  const canonicalSpeaker = beat.speakerName
    ? builtInForName(beat.speakerName)?.characterName ?? beat.speakerName.trim()
    : null;
  const speakerKey = canonicalSpeaker ? normalizeName(canonicalSpeaker) : null;

  for (const candidate of candidates) {
    const builtIn = builtInForName(candidate);
    const canonicalName = builtIn?.characterName ?? candidate.trim();
    const key = normalizeName(canonicalName);
    if (!canonicalName || emitted.has(key)) continue;
    const configured = configuredReferences.find((reference) => normalizeName(reference.characterName) === key);
    if (!configured) continue;
    const image = imageSource(configured.imageUrl.trim());
    const exactDialogueAudio = key === speakerKey && beat.dialogueAudioUrl?.startsWith('https://')
      ? beat.dialogueAudioUrl
      : undefined;
    const fallbackVoiceSample = key === speakerKey && configured.audioUrl.trim().startsWith('https://')
      ? configured.audioUrl.trim()
      : undefined;
    const audioUrl = exactDialogueAudio ?? fallbackVoiceSample;
    const audioRole = exactDialogueAudio ? 'dialogue_performance' : audioUrl ? 'voice_sample' : undefined;
    const referenceMediaCount = Number(Boolean(image.assetKey || image.imageUrl)) + Number(Boolean(audioUrl));
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
