import { splitBeatDescription } from './evd';
import type { DssBrowserEvent, DssCommand, DssCommandGroup, StoryBeat } from './types';

const STYLE_PREFIX =
  'Cinematic live-action story scene, expressive natural performances, moody practical lighting, shallow depth of field, coherent characters, subtle ambient sound, no titles or captions.';
const MIN_CLIP_SECONDS = 5;
const MAX_CLIP_SECONDS = 15;
const PERFORMANCE_PADDING_SECONDS = 1.25;
const ESTIMATED_SPOKEN_WORDS_PER_SECOND = 2.3;

export interface DssShotPlannerState {
  setting: string | null;
  characters: Set<string>;
  emotions: Map<string, string>;
  sceneIndex: number | null;
  emittedShotFingerprints: Set<string>;
}

export function createDssShotPlannerState(): DssShotPlannerState {
  return {
    setting: null,
    characters: new Set(),
    emotions: new Map(),
    sceneIndex: null,
    emittedShotFingerprints: new Set(),
  };
}

function shotFingerprint(...parts: string[]): string {
  return parts.join('|').trim().replace(/\s+/g, ' ').toLowerCase();
}

function admitShot(state: DssShotPlannerState, fingerprint: string): boolean {
  if (state.emittedShotFingerprints.has(fingerprint)) return false;
  state.emittedShotFingerprints.add(fingerprint);
  return true;
}

function commandName(command: DssCommand): string {
  return (command.command ?? '').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
}

function args(command: DssCommand): Record<string, unknown> {
  return command.args ?? command.content ?? {};
}

function textArg(command: DssCommand, key: string): string | null {
  const value = args(command)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberArg(command: DssCommand, key: string): number | null {
  const value = args(command)[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nestedName(command: DssCommand, key: string): string | null {
  const value = args(command)[key];
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = (value as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function isTalk(command: DssCommand): boolean {
  const name = commandName(command).replace(/\s/g, '');
  return name === 'talk' || name === 'charactertalk';
}

function isEnableSet(command: DssCommand): boolean {
  return commandName(command).replace(/\s/g, '') === 'enableset';
}

function isAddCharacter(command: DssCommand): boolean {
  const name = commandName(command).replace(/\s/g, '');
  return name === 'addcharacter' || name === 'spawncharacter';
}

function isContextRestoration(command: DssCommand): boolean {
  return isEnableSet(command) || isAddCharacter(command);
}

function updatePersistentContext(command: DssCommand, state: DssShotPlannerState): void {
  if (isEnableSet(command)) state.setting = textArg(command, 'set') ?? state.setting;
  if (isAddCharacter(command)) {
    const character = textArg(command, 'name') ?? textArg(command, 'character');
    if (character) state.characters.add(character);
  }
  if (commandName(command) === 'set emotion') {
    const character = textArg(command, 'character');
    const emotion = textArg(command, 'emotion');
    if (character && emotion) state.emotions.set(character, emotion);
  }
}

function describeVisualCommand(command: DssCommand): string | null {
  const name = commandName(command);
  const character = textArg(command, 'character') ?? textArg(command, 'name');
  switch (name.replace(/\s/g, '')) {
    case 'enableset': {
      const setName = textArg(command, 'set');
      const timeOfDay = textArg(command, 'time_of_day');
      return setName ? `Establish ${setName}${timeOfDay ? ` at ${timeOfDay}` : ''}.` : null;
    }
    case 'addcharacter':
    case 'spawncharacter':
      return character ? `${character} enters the scene.` : null;
    case 'charactermoveto': {
      const location = nestedName(command, 'location');
      return character && location ? `${character} moves toward ${location}.` : null;
    }
    case 'look': {
      const target = nestedName(command, 'target');
      return character && target ? `${character} looks toward ${target}.` : null;
    }
    case 'setemotion': {
      const emotion = textArg(command, 'emotion');
      return character && emotion ? `${character}'s expression becomes ${emotion}.` : null;
    }
    case 'playanimation': {
      const animation = textArg(command, 'animation');
      return character && animation ? `${character} performs ${animation}.` : null;
    }
    case 'enterinterrogationroom':
      return character ? `${character} enters the interrogation room.` : null;
    case 'leaveinterrogationroom':
      return character ? `${character} leaves the interrogation room.` : null;
    case 'charactershot':
    case 'charactercamera': {
      const shot = textArg(command, 'shot');
      return character ? `Frame ${character} in a ${shot ?? 'medium'} shot.` : null;
    }
    case 'stillshot': {
      const shot = textArg(command, 'shot name') ?? textArg(command, 'preset');
      return shot ? `Use the ${shot} camera composition.` : null;
    }
    // Cutscenes already point at finished video assets. Re-generating their
    // renderer-control metadata creates an unrelated text-to-video opening.
    case 'cutscene':
      return null;
    default:
      return null;
  }
}

function splitIntoCount(value: string, count: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (count <= 1 || words.length <= 1) return [value.trim()];
  const actualCount = Math.min(count, words.length);
  const chunkSize = Math.ceil(words.length / actualCount);
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += chunkSize) {
    chunks.push(words.slice(index, index + chunkSize).join(' '));
  }
  return chunks;
}

interface DialogueShot {
  dialogue: string;
  durationSeconds: number;
}

function spokenWordCount(value: string): number {
  return value
    .replace(/\[[^\]]*]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function estimatedAudioDuration(value: string): number {
  return spokenWordCount(value) / ESTIMATED_SPOKEN_WORDS_PER_SECOND;
}

function clipDuration(audioDuration: number, minimumDuration: number): number {
  return Math.min(
    MAX_CLIP_SECONDS,
    Math.max(MIN_CLIP_SECONDS, minimumDuration, Math.ceil(audioDuration + PERFORMANCE_PADDING_SECONDS)),
  );
}

function dialogueShots(command: DssCommand, minimumDuration: number): DialogueShot[] {
  const dialogue = textArg(command, 'dialogue');
  if (!dialogue) return [];
  const authoritativeDuration = numberArg(command, 'audio_duration');
  const audioDuration = authoritativeDuration && authoritativeDuration > 0
    ? authoritativeDuration
    : estimatedAudioDuration(dialogue);
  const requestedDuration = clipDuration(audioDuration, minimumDuration);
  if (audioDuration + PERFORMANCE_PADDING_SECONDS <= MAX_CLIP_SECONDS) {
    return [{ dialogue, durationSeconds: requestedDuration }];
  }

  const maximumSpeechSeconds = MAX_CLIP_SECONDS - PERFORMANCE_PADDING_SECONDS;
  const minimumChunks = Math.ceil(audioDuration / maximumSpeechSeconds);
  const semanticChunks = splitBeatDescription(dialogue, MAX_CLIP_SECONDS);
  const chunks = semanticChunks.length >= minimumChunks
    ? semanticChunks
    : splitIntoCount(dialogue, minimumChunks);
  const totalWords = Math.max(1, spokenWordCount(dialogue));
  return chunks.map((chunk) => {
    const chunkAudioDuration = authoritativeDuration && authoritativeDuration > 0
      ? audioDuration * (Math.max(1, spokenWordCount(chunk)) / totalWords)
      : estimatedAudioDuration(chunk);
    return {
      dialogue: chunk,
      durationSeconds: clipDuration(chunkAudioDuration, minimumDuration),
    };
  });
}

function contextParts(state: DssShotPlannerState): string[] {
  const parts: string[] = [];
  if (state.setting) parts.push(`Setting: ${state.setting}.`);
  if (state.characters.size > 0) {
    const cast = [...state.characters].map((character) => {
      const emotion = state.emotions.get(character);
      return emotion ? `${character} (${emotion})` : character;
    });
    parts.push(`Characters present: ${cast.join(', ')}.`);
  }
  return parts;
}

function uniqueCharacterNames(values: Array<string | null>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = value?.trim();
    const key = name?.toLocaleLowerCase();
    if (!name || !key || seen.has(key)) continue;
    names.push(name);
    seen.add(key);
  }
  return names;
}

function groupId(group: DssCommandGroup, event: DssBrowserEvent, groupIndex: number): string {
  return group.id?.trim() || `${event.sequence}-${groupIndex}`;
}

export function dssEventKey(event: DssBrowserEvent): string {
  return `${event.episode_id}:${event.sequence}`;
}

export function buildStoryShots(
  event: DssBrowserEvent,
  durationSeconds: number,
  state: DssShotPlannerState,
): StoryBeat[] {
  const groups = event.script.command_groups ?? [];
  const baseId = event.story_block_id || event.script.story_block_id || `sequence-${event.sequence}`;
  const sceneIndex = event.script.scene_index ?? 0;
  const blockIndex = event.script.story_block_index ?? 0;
  const sourceEventKey = dssEventKey(event);
  const shots: StoryBeat[] = [];

  if (state.sceneIndex !== sceneIndex) {
    state.sceneIndex = sceneIndex;
    state.characters.clear();
    state.emotions.clear();
    state.emittedShotFingerprints.clear();
  }

  groups.forEach((group, groupIndex) => {
    const commands = group.commands ?? [];
    for (const command of commands) updatePersistentContext(command, state);
    const visualActions = commands
      .filter((command) => !isTalk(command) && !isContextRestoration(command))
      .map(describeVisualCommand)
      .filter((value): value is string => Boolean(value));
    const talkCommands = commands.filter(isTalk);
    const stableGroupId = groupId(group, event, groupIndex);

    if (talkCommands.length === 0 && visualActions.length > 0) {
      const fingerprint = shotFingerprint('action', ...visualActions);
      if (!admitShot(state, fingerprint)) return;
      const directlyNamedCharacters = uniqueCharacterNames(commands.map((command) =>
        textArg(command, 'character') ?? textArg(command, 'name'),
      ));
      shots.push({
        storyBlockId: `${baseId}:${stableGroupId}:action`,
        sceneIndex,
        blockIndex,
        sequence: event.sequence * 1_000_000 - groupIndex * 10_000,
        durationSeconds: Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, durationSeconds)),
        prompt: [STYLE_PREFIX, ...contextParts(state), `The focused action is: ${visualActions.join(' ')}`].join(' '),
        title: `Scene ${sceneIndex + 1} · DSS group ${groupIndex + 1}`,
        source: 'live',
        sourceEventKey,
        sourceGroupId: stableGroupId,
        // Establishing/action commands often omit a character argument even though
        // earlier DSS setup groups already declared who is present in the scene.
        characterNames: directlyNamedCharacters.length > 0
          ? directlyNamedCharacters
          : [...state.characters],
      });
      return;
    }

    talkCommands.forEach((command, talkIndex) => {
      const speaker = textArg(command, 'character') ?? 'A character';
      const respondent = textArg(command, 'respondent');
      const tone = textArg(command, 'tone');
      const cameraShot = textArg(command, 'camera_shot')?.replace(/_/g, ' ');
      const plannedShots = dialogueShots(command, durationSeconds);
      const dialogueAudioDuration = numberArg(command, 'audio_duration');
      const dialogueAudioUrl = plannedShots.length === 1 ? textArg(command, 'audio') : null;
      plannedShots.forEach(({ dialogue, durationSeconds: shotDuration }, chunkIndex) => {
        const fingerprint = shotFingerprint('dialogue', speaker, dialogue);
        if (!admitShot(state, fingerprint)) return;
        const direction = [
          cameraShot ? `Camera: ${cameraShot}.` : null,
          visualActions.length > 0 ? `Concurrent action: ${visualActions.join(' ')}` : null,
          `${speaker}${tone ? ` (${tone})` : ''} speaks${respondent ? ` to ${respondent}` : ''}: “${dialogue}”`,
        ].filter((value): value is string => Boolean(value));
        shots.push({
          storyBlockId: `${baseId}:${stableGroupId}:talk-${talkIndex}-${chunkIndex}`,
          sceneIndex,
          blockIndex,
          sequence: event.sequence * 1_000_000 - groupIndex * 10_000 - talkIndex * 100 - chunkIndex,
          durationSeconds: shotDuration,
          prompt: [STYLE_PREFIX, ...contextParts(state), ...direction].join(' '),
          title: `${speaker}${plannedShots.length > 1 ? ` · Shot ${chunkIndex + 1}/${plannedShots.length}` : ''}`,
          source: 'live',
          chunkIndex,
          chunkCount: plannedShots.length,
          sourceEventKey,
          sourceGroupId: stableGroupId,
          characterNames: uniqueCharacterNames([speaker, respondent]),
          speakerName: speaker,
          ...(dialogueAudioUrl?.startsWith('https://') ? {
            dialogueAudioUrl,
            ...(dialogueAudioDuration !== null && dialogueAudioDuration > 0
              ? { dialogueAudioDurationSeconds: dialogueAudioDuration }
              : {}),
          } : {}),
        });
      });
    });
  });

  return shots;
}

export function mergeStoryBeat(current: StoryBeat | undefined, next: StoryBeat): StoryBeat {
  if (!current || next.prompt.length >= current.prompt.length) return next;
  return { ...current, sequence: Math.max(current.sequence, next.sequence) };
}
