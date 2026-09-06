import { sceneContextPrompt, type MinimaxSceneContext } from './scene-context.js';

/** PIC-1410: Deterministic DSS compilation; generation and playback belong to the caller. */
export interface VoiceReference {
  url: string;
  durationSeconds: number;
}

export interface CharacterReference {
  name?: string;
  aliases?: readonly string[];
  description?: string;
  imageUrl?: string;
  voice?: VoiceReference;
}

export interface ShotPlannerSettings {
  /** Initial-frame models accept one scheduler-supplied frame, not reference arrays or voice conditioning. */
  referenceMode?: 'reference' | 'initial-frame';
  characters?: Readonly<Record<string, CharacterReference>>;
  aliases?: Readonly<Record<string, string>>;
  sets?: Readonly<Record<string, { description?: string; imageUrl?: string }>>;
  styleImageUrl?: string;
  styleDescription?: string;
  initialImageUrl?: string;
  markNames?: Readonly<Record<string, string>>;
  useDialogueAudioReferences?: boolean;
  defaultDurationSeconds?: number;
}

export interface CharacterStaging {
  name: string;
  characterId?: string;
  /** Authoritative scene-level blocking; supersedes engine-specific spawn marks. */
  certifiedPosition?: string;
  zone?: string;
  mark?: string;
  posture: string;
  gaze?: string;
  emotion?: string;
  appearance?: string;
}

export interface ShotPlannerState {
  set: string | null;
  sceneIndex?: number;
  dressing?: string;
  timeOfDay?: string;
  backdropImageUrl?: string;
  characters: Readonly<Record<string, Readonly<CharacterStaging>>>;
  camera: Readonly<{ shot: string; character?: string }>;
  sceneRevision: number;
  continuityRevision: number;
}

export interface PlannedImageReference { name: string; url: string; label: string; assetId?: string }
export interface PlannedAudioReference extends PlannedImageReference {
  durationSeconds: number;
  purpose: 'dialogue' | 'voice';
}

export interface PlannedShot {
  id: string;
  groupId: string;
  storyBlockId: string;
  prompt: string;
  durationSeconds: number;
  dialogue?: string;
  speaker?: string;
  /** Estimated segment duration when a line is split; original duration is retained separately. */
  audioDurationSeconds?: number;
  sourceAudioDurationSeconds?: number;
  /** Exact performance audio is usable only when the complete line fits this one shot. */
  dialogueAudioUrl?: string;
  referenceImageUrls: readonly string[];
  referenceAudioUrls: readonly string[];
  imageReferences: readonly PlannedImageReference[];
  audioReferences: readonly PlannedAudioReference[];
  setupKey: string;
  continuityKey: string;
  sceneKey: string;
  /** Camera-anchor identity: scene, framing, speaker/eyeline pair, and the blocking of on-screen cast only. */
  anchorKey: string;
  requiresPreviousFrame: boolean;
  hasMovement: boolean;
  startingState: ShotPlannerState;
  resultingState: ShotPlannerState;
  actions: readonly string[];
}

export interface PlannedGroup {
  groupId: string;
  storyBlockId: string;
  shots: readonly PlannedShot[];
  delaySeconds: number;
  startingState: ShotPlannerState;
  resultingState: ShotPlannerState;
}

type ObjectValue = Record<string, unknown>;
type MutableState = Omit<ShotPlannerState, 'characters' | 'camera'> & {
  characters: Record<string, CharacterStaging>;
  camera: { shot: string; character?: string };
};
interface DeliveryDirection { text: string; wordOffset: number }
interface Line { speaker: string; dialogue: string; deliveryDirections: readonly DeliveryDirection[]; duration: number; audio?: string; tone?: string; respondent?: string; camera: MutableState['camera'] }
interface DialogueSegment { dialogue: string; duration: number; deliveryDirections: readonly string[] }

// In-place performance animations observed in StoryKernel output; they never displace the actor.
const STATIONARY_ANIMATIONS = new Set([
  'talking', 'finger point', 'exasperated', 'hands on hips', 'smug', 'dismissive', 'one hand gesture', 'thinking',
  'sarcastic', 'paranoid', 'sad', 'embarassed talking', 'embarrassed talking', 'angry', 'look around', 'annoyed',
  'scared', 'hand on hip yes', 'surprised', 'look away',
]);
const CONTROL_COMMANDS = new Set([
  'cutscene', 'showtitle', 'showcredits', 'credits', 'delay', 'fade', 'showdebug',
  'setfps', 'setstorymode', 'setchannelvolume', 'depthoffield', 'stopaudio', 'playaudio',
]);
const CAMERA_NAMES: Record<string, string> = {
  Character_ExtremeCloseUp: 'extreme close-up', Character_CloseUp: 'close-up',
  Character_Medium: 'medium shot', Character_Full: 'full-body shot',
  Character_POV: 'point-of-view shot', Character_OverShoulder: 'over-the-shoulder shot',
};

function object(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function required(value: unknown, label: string): string {
  const result = text(value);
  if (!result) throw new Error(`${label} is required`);
  return result;
}
function nameOf(value: unknown): string | undefined {
  return text(value) ?? text(object(value).name) ?? text(object(value).mark);
}
function numeric(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}
function normalize(value: string): string { return value.trim().toLowerCase(); }
function humanize(value: string): string { return value.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'); }
function isCloseUp(shot: string): boolean {
  // A POV identifies a viewpoint, not an on-screen subject. Keep it outside the
  // close-up visibility/eyeline rules until its geometry is explicitly modeled.
  return (CAMERA_NAMES[shot] ?? shot).toLowerCase().replace(/[\s_-]+/g, '').includes('closeup');
}
function httpsUrl(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${label} must be an absolute HTTPS URL without credentials`);
  return value;
}
function resolvedSceneImage(value: string, label: string): string {
  if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(value)) {
    throw new Error(`${label} must be a resolved image data URL`);
  }
  return value;
}
function clone<T>(value: T): T { return structuredClone(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function stateSnapshot(value: MutableState): ShotPlannerState { return freeze(clone(value)); }
function words(value: string): string[] { return value.trim().split(/\s+/).filter(Boolean); }

/** DSS inline square brackets are TTS acting directions, never spoken words. */
function spokenDialogue(raw: string): { dialogue: string; deliveryDirections: DeliveryDirection[] } {
  const deliveryDirections: DeliveryDirection[] = [];
  let spoken = '';
  let offset = 0;
  for (const match of raw.matchAll(/\[([^\]]*)\]/g)) {
    spoken += raw.slice(offset, match.index);
    const direction = match[1].trim();
    if (direction) deliveryDirections.push({ text: direction, wordOffset: words(spoken).length });
    spoken += ' ';
    offset = match.index! + match[0].length;
  }
  const dialogue = (spoken + raw.slice(offset)).replace(/\s+/g, ' ').trim();
  if (!dialogue) throw new Error('talk dialogue contains no spoken words after delivery directions');
  return { dialogue, deliveryDirections };
}

/** Preserve every spoken word; prefer sentence boundaries without exceeding the time budget. */
function splitLine(line: Line): DialogueSegment[] {
  if (line.duration <= 15) return [{ dialogue: line.dialogue, duration: line.duration, deliveryDirections: line.deliveryDirections.map((direction) => direction.text) }];
  const tokens = words(line.dialogue);
  const secondsPerWord = line.duration / tokens.length;
  const maximumWords = Math.floor(15 / secondsPerWord);
  if (maximumWords < 1) throw new Error('Dialogue cannot be safely split into 15-second shots without word-level audio timing');
  const segments: DialogueSegment[] = [];
  for (let offset = 0; offset < tokens.length;) {
    let length = Math.min(maximumWords, tokens.length - offset);
    if (offset + length < tokens.length) {
      // A short trailing sentence is better than breaking an earlier sentence in half.
      for (let candidate = length; candidate >= Math.ceil(length / 2); candidate--) {
        if (/[.!?]["'”’)]*$/.test(tokens[offset + candidate - 1])) { length = candidate; break; }
      }
    }
    const end = offset + length;
    const deliveryDirections = line.deliveryDirections.filter((direction) => direction.wordOffset >= offset && (direction.wordOffset < end || end === tokens.length)).map((direction) => direction.text);
    segments.push({ dialogue: tokens.slice(offset, end).join(' '), duration: length * secondsPerWord, deliveryDirections });
    offset += length;
  }
  return segments;
}

export class DssShotPlanner {
  private readonly settings: ShotPlannerSettings;
  private readonly aliases = new Map<string, string>();
  private readonly characterReferences = new Map<string, CharacterReference>();
  private readonly setReferences = new Map<string, { description?: string; imageUrl?: string }>();
  private sceneContext: MinimaxSceneContext | null = null;
  private sceneContextIdentity: string | null = null;
  private current: MutableState = { set: null, characters: {}, camera: { shot: 'medium shot' }, sceneRevision: 0, continuityRevision: 0 };

  constructor(settings: ShotPlannerSettings = {}) {
    this.settings = freeze(clone(settings));
    const duration = settings.defaultDurationSeconds ?? 5;
    if (!Number.isFinite(duration) || duration < 5 || duration > 15) throw new Error('defaultDurationSeconds must be between 5 and 15');
    for (const [key, reference] of Object.entries(this.settings.characters ?? {})) {
      const name = reference.name?.trim() || key.trim();
      if (!name) throw new Error('Character reference name is required');
      const previous = this.characterReferences.get(normalize(name));
      if (previous) throw new Error(`Duplicate character reference: ${name}`);
      this.characterReferences.set(normalize(name), reference);
      for (const alias of [key, name, ...(reference.aliases ?? [])]) this.registerAlias(alias, name);
      if (reference.imageUrl) httpsUrl(reference.imageUrl, `${name} image`);
      if (reference.voice) this.validateVoice(reference.voice, `${name} voice`);
    }
    const extraAliases = new Map(Object.entries(this.settings.aliases ?? {}).map(([alias, target]) => [normalize(alias), target]));
    const resolveAlias = (name: string, visited = new Set<string>()): string => {
      const key = normalize(name);
      const known = this.aliases.get(key);
      if (known) return known;
      const target = extraAliases.get(key);
      if (!target) return name.trim();
      if (visited.has(key)) throw new Error(`Cyclic character alias: ${name}`);
      visited.add(key);
      return resolveAlias(target, visited);
    };
    for (const [alias, target] of extraAliases) this.registerAlias(alias, resolveAlias(target, new Set([alias])));
    for (const [key, reference] of Object.entries(this.settings.sets ?? {})) {
      if (reference.imageUrl) httpsUrl(reference.imageUrl, `${key} set image`);
      this.setReferences.set(normalize(key), reference);
    }
    for (const [name, url] of [['style image', settings.styleImageUrl], ['initial image', settings.initialImageUrl]]) {
      if (url) httpsUrl(url, name!);
    }
  }

  get state(): ShotPlannerState { return stateSnapshot(this.current); }

  applySceneContext(context: MinimaxSceneContext | null, sceneIndex?: number): void {
    if (sceneIndex !== undefined && !Number.isInteger(sceneIndex)) throw new Error('DSS scene_index must be an integer');
    // Synthetic initialization metadata uses -1. It must not clear an authored scene.
    const index = sceneIndex !== undefined && sceneIndex >= 0 ? sceneIndex : this.current.sceneIndex;
    const changedIndex = index !== undefined && this.current.sceneIndex !== undefined && index !== this.current.sceneIndex;
    if (context === null) {
      if (changedIndex) {
        this.sceneContext = null;
        this.sceneContextIdentity = null;
        this.resetScene(index);
      } else if (index !== undefined) {
        this.current.sceneIndex = index;
        if (this.sceneContext) this.sceneContextIdentity = this.contextIdentity(this.sceneContext, index);
      }
      // Missing context in the next streamed group means retain the scene, not
      // drop its certified assets. A real scene-index change clears it above.
      return;
    }
    const identity = this.contextIdentity(context, index);
    const changed = changedIndex || identity !== this.sceneContextIdentity;
    this.sceneContext = freeze(clone(context));
    this.sceneContextIdentity = identity;
    if (changed) this.resetScene(index, this.sceneContext);
  }

  private contextIdentity(context: MinimaxSceneContext, sceneIndex?: number): string {
    const cast = context.characterImages.map(image => [image.sourceId, image.characterName, image.assetId, context.characterPositions[image.sourceId]])
      .sort((left, right) => String(left[0]) < String(right[0]) ? -1 : String(left[0]) > String(right[0]) ? 1 : 0);
    return JSON.stringify([sceneIndex ?? null, context.setImage.sourceId, context.setImage.assetId, cast]);
  }

  private resetScene(sceneIndex?: number, context?: MinimaxSceneContext): void {
    this.current = {
      set: context?.setImage.sourceId ?? null,
      ...(sceneIndex === undefined ? {} : { sceneIndex }),
      characters: Object.fromEntries((context?.characterImages ?? []).map(image => [image.characterName!, {
        name: image.characterName!, characterId: image.sourceId, certifiedPosition: context!.characterPositions[image.sourceId], posture: 'as authored',
      }])),
      camera: { shot: 'medium shot' },
      sceneRevision: this.current.sceneRevision + 1,
      continuityRevision: this.current.continuityRevision + 1,
    };
  }

  private registerAlias(alias: string, name: string): void {
    const key = normalize(alias);
    if (!key || !name) throw new Error('Character aliases must have non-empty names');
    const previous = this.aliases.get(key);
    if (previous && previous !== name) throw new Error(`Ambiguous character alias: ${alias}`);
    this.aliases.set(key, name);
  }

  private canonical(raw: string, state: MutableState): string {
    if (this.sceneContext) {
      const certified = this.sceneContext.characterImages.find(image => image.characterName === raw || normalize(image.sourceId) === normalize(raw));
      // Certified names are exact. Configured aliases must not rebind them, nor
      // should case folding hide a mismatch in the producer's name/ID contract.
      return certified?.characterName ?? raw.trim();
    }
    const key = normalize(raw);
    return this.aliases.get(key) ?? Object.keys(state.characters).find((name) => normalize(name) === key) ?? raw.trim();
  }

  private validateVoice(voice: VoiceReference, label: string): void {
    httpsUrl(voice.url, label);
    if (!Number.isFinite(voice.durationSeconds) || voice.durationSeconds < 2 || voice.durationSeconds > 15) {
      throw new Error(`${label} duration must be between 2 and 15 seconds`);
    }
  }

  planGroup(commands: readonly ObjectValue[], groupId: string, storyBlockId: string): PlannedGroup {
    required(groupId, 'groupId'); required(storyBlockId, 'storyBlockId');
    const startingState = this.state;
    let visualStartingState = startingState;
    const next = clone(this.current);
    const actions: string[] = [];
    const lines: Line[] = [];
    const participants = new Set<string>();
    let hasMovement = false;
    let delaySeconds = 0;
    const actor = (raw: unknown): CharacterStaging => {
      const name = this.canonical(required(raw, 'DSS character'), next);
      if (this.sceneContext && !this.sceneContext.characterImages.some(image => image.characterName === name)) throw new Error(`DSS character has no certified scene image: ${name}`);
      participants.add(name);
      if (!Object.hasOwn(next.characters, name)) {
        Object.defineProperty(next.characters, name, { value: { name, posture: 'standing' }, enumerable: true, writable: true, configurable: true });
        next.continuityRevision++;
      }
      return next.characters[name];
    };
    const change = (character: CharacterStaging, update: Partial<CharacterStaging>): void => {
      if (Object.entries(update).some(([key, value]) => character[key as keyof CharacterStaging] !== value)) next.continuityRevision++;
      Object.assign(character, update);
    };

    for (const command of commands) {
      const rawName = required(command.command, 'DSS command');
      const name = rawName.toLowerCase().replace(/[\s_-]+/g, '');
      const args = object(command.args ?? command.content);
      const delay = numeric(command.delay) ?? 0;
      if (delay < 0) throw new Error('DSS command delay cannot be negative');
      delaySeconds = Math.max(delaySeconds, delay);
      if (CONTROL_COMMANDS.has(name)) {
        const duration = Math.max(0, ...[args.duration, args.duration_seconds, args.seconds].map((value) => numeric(value) ?? 0));
        delaySeconds = Math.max(delaySeconds, delay + duration);
        continue;
      }
      switch (name) {
        case 'enableset': {
          const set = required(args.set, 'enable set name');
          if (this.sceneContext) break; // Certified set identity wins over legacy display-name restores.
          const dressing = text(args.dressing);
          const timeOfDay = text(args.time_of_day);
          if (set !== next.set || dressing !== next.dressing || timeOfDay !== next.timeOfDay) {
            next.sceneRevision++; next.continuityRevision++;
            next.characters = {}; next.camera = { shot: 'medium shot' }; delete next.backdropImageUrl;
          }
          Object.assign(next, { set, dressing, timeOfDay });
          break;
        }
        case 'hsbackdropsettexture': {
          const url = httpsUrl(required(args.texture, 'backdrop texture'), 'backdrop texture');
          if (url !== next.backdropImageUrl) next.continuityRevision++;
          next.backdropImageUrl = url;
          break;
        }
        case 'addcharacter': case 'spawncharacter': {
          const character = actor(args.name ?? args.character);
          if (character.certifiedPosition) break; // Do not replace authored blocking with UE spawn marks.
          const point = object(args.point);
          change(character, {
            ...(text(args.zone ?? point.zone) ? { zone: text(args.zone ?? point.zone) } : {}),
            ...(text(point.mark) ? { mark: text(point.mark) } : {}),
            ...(text(args.posture) ? { posture: text(args.posture)! } : {}),
            ...(text(args.appearance ?? args.costume) ? { appearance: text(args.appearance ?? args.costume) } : {}),
          });
          break;
        }
        case 'removecharacter': case 'despawncharacter': {
          const character = actor(args.name ?? args.character);
          if (character.certifiedPosition) throw new Error('DSS cast removal conflicts with fixed certified scene positions; provide a new scene context');
          delete next.characters[character.name]; next.continuityRevision++;
          break;
        }
        case 'charactermoveto': {
          const character = actor(args.character);
          if (character.certifiedPosition) throw new Error('DSS movement conflicts with fixed certified scene positions; provide a new scene context');
          const location = object(args.location);
          const mark = required(nameOf(args.location), 'character move destination');
          change(character, { mark, ...(text(location.zone) ? { zone: text(location.zone) } : {}) });
          actions.push(`${character.name} walks to ${this.markName(mark)}.`); hasMovement = true;
          break;
        }
        case 'sit': case 'stand': {
          const character = actor(args.character);
          if (character.certifiedPosition) throw new Error('DSS posture change conflicts with fixed certified scene positions; provide a new scene context');
          change(character, { posture: name === 'sit' ? 'sitting' : 'standing' });
          actions.push(`${character.name} ${name === 'sit' ? 'sits down' : 'stands up'}.`); hasMovement = true;
          break;
        }
        case 'look': {
          const character = actor(args.character);
          const target = this.canonical(required(nameOf(args.target), 'look target name'), next);
          character.gaze = `${target}${object(args.target).bias === 'eyes' ? ' (eye contact)' : ''}`;
          break;
        }
        case 'setemotion': {
          const character = actor(args.character);
          character.emotion = required(args.emotion, 'emotion');
          break;
        }
        case 'playanimation': {
          const character = actor(args.character);
          const animation = required(args.animation, 'animation');
          actions.push(`${character.name} performs ${humanize(animation)}.`);
          // Unknown animations may move the actor, so invalidate conservatively.
          if (!STATIONARY_ANIMATIONS.has(normalize(animation).replace(/[\s_-]+/g, ' '))) { next.continuityRevision++; hasMovement = true; }
          break;
        }
        case 'charactershot': case 'charactercamera': {
          const character = actor(args.character);
          next.camera = { shot: text(args.shot) ?? 'medium shot', character: character.name };
          break;
        }
        case 'stillshot':
          next.camera = { shot: required(args['shot name'] ?? args.preset, 'still shot name'), ...(nameOf(args.target) ? { character: this.canonical(nameOf(args.target)!, next) } : {}) };
          break;
        case 'talk': case 'charactertalk': {
          const character = actor(args.character);
          const { dialogue, deliveryDirections } = spokenDialogue(required(args.dialogue, 'talk dialogue'));
          const providedDuration = numeric(args.audio_duration);
          if (args.audio_duration !== undefined && args.audio_duration !== null && providedDuration === undefined) throw new Error('talk audio_duration must be numeric');
          const duration = providedDuration ?? words(dialogue).length / 2.3;
          if (duration <= 0) throw new Error('talk audio_duration must be positive');
          const respondent = text(args.respondent) ? this.canonical(text(args.respondent)!, next) : undefined;
          if (respondent && this.sceneContext && !this.sceneContext.characterImages.some(image => image.characterName === respondent)) throw new Error(`DSS character has no certified scene image: ${respondent}`);
          if (respondent) participants.add(respondent);
          if (text(args.camera_shot)) next.camera = { shot: text(args.camera_shot)!, character: character.name };
          lines.push({ speaker: character.name, dialogue, deliveryDirections, duration, audio: text(args.audio), tone: text(args.tone), respondent, camera: clone(next.camera) });
          break;
        }
        default: throw new Error(`Unsupported DSS command: ${rawName}`);
      }
      // Restored set/cast context describes the start of a generated shot. It must
      // not leak old-scene marks into a group that restores context before speaking.
      if (lines.length === 0 && actions.length === 0) visualStartingState = stateSnapshot(next);
    }

    const resultingState = stateSnapshot(next);
    const shots: PlannedShot[] = [];
    const createShot = (line?: Line, segment?: DialogueSegment, split = false): void => {
      const index = shots.length;
      const camera = line?.camera ?? next.camera;
      const shotStart = index === 0 ? visualStartingState : shots[index - 1].resultingState;
      const shotEnd = stateSnapshot({ ...next, camera });
      const shotActions = index === 0 ? actions : [];
      const names = [...new Set([...Object.keys(next.characters), ...participants])].sort((a, b) => normalize(a) < normalize(b) ? -1 : normalize(a) > normalize(b) ? 1 : 0);
      const cameraSubject = camera.character ?? line?.speaker;
      // Keep off-screen cast in scene state and eyeline prose, but their portraits
      // can pull a close-up toward the wrong face. Wider/unmodeled views retain
      // staged cast; reaction close-ups use the explicitly framed listener.
      const visibleNames = isCloseUp(camera.shot) && cameraSubject && names.includes(cameraSubject) ? [cameraSubject] : names;
      const refs = this.references(visibleNames, next, line, split);
      const sourceDuration = segment?.duration;
      const durationSeconds = Math.max(this.settings.defaultDurationSeconds ?? 5, Math.ceil(sourceDuration ?? 5));
      if (durationSeconds > 15) throw new Error('Planned shot exceeds the 15-second provider limit');
      const sceneKey = JSON.stringify([next.sceneIndex ?? null, this.sceneContextIdentity, next.set, next.dressing, next.timeOfDay, next.sceneRevision]);
      const setupKey = JSON.stringify([next.set, camera.shot, camera.character ?? line?.speaker ?? null]);
      const continuityKey = JSON.stringify([sceneKey, next.continuityRevision]);
      // Off-screen cast changing marks must not discard this setup's established frame.
      const involved = [...new Set([...visibleNames, ...(line?.respondent ? [line.respondent] : [])])].sort();
      const blocking = involved.map(name => {
        const { zone, mark, posture, appearance, certifiedPosition } = next.characters[name] ?? { posture: 'standing' };
        return [name, zone ?? null, mark ?? null, posture, appearance ?? null, certifiedPosition ?? null];
      });
      const anchorKey = JSON.stringify([sceneKey, next.backdropImageUrl ?? null, camera.shot, cameraSubject ?? null, line?.speaker ?? null, line?.respondent ?? null, blocking]);
      const id = `${storyBlockId}:${groupId}:${index}`;
      shots.push(freeze({
        id, groupId, storyBlockId,
        prompt: this.prompt(names, refs, shotStart, shotEnd, shotActions, camera, line, segment, durationSeconds),
        durationSeconds, ...(line ? { speaker: line.speaker, dialogue: segment!.dialogue, audioDurationSeconds: sourceDuration, sourceAudioDurationSeconds: line.duration } : {}),
        ...(!split && line?.audio ? { dialogueAudioUrl: httpsUrl(line.audio, 'dialogue audio') } : {}),
        referenceImageUrls: refs.images.map((entry) => entry.url), referenceAudioUrls: refs.audios.map((entry) => entry.url),
        imageReferences: refs.images, audioReferences: refs.audios,
        setupKey, continuityKey, sceneKey, anchorKey, requiresPreviousFrame: index > 0 || hasMovement,
        hasMovement: index === 0 && hasMovement, startingState: shotStart, resultingState: shotEnd, actions: [...shotActions],
      }));
    };
    for (const line of lines) {
      const segments = splitLine(line);
      for (const segment of segments) createShot(line, segment, segments.length > 1);
    }
    if (!lines.length && actions.length) createShot();
    // Commit only after compilation and all reference/duration validation succeeds.
    this.current = next;
    return freeze({ groupId, storyBlockId, shots, delaySeconds, startingState, resultingState });
  }

  private markName(mark: string): string { return this.settings.markNames?.[mark] ?? humanize(mark.split('.').at(-1) ?? mark); }

  private references(names: string[], state: MutableState, line?: Line, split = false): { images: PlannedImageReference[]; audios: PlannedAudioReference[] } {
    const images: PlannedImageReference[] = [];
    const audios: PlannedAudioReference[] = [];
    if (this.settings.referenceMode === 'initial-frame') return { images, audios };
    const image = (name: string, url?: string, assetId?: string): void => {
      if (url) images.push({
        name,
        url: assetId ? resolvedSceneImage(url, `${name} image`) : httpsUrl(url, `${name} image`),
        label: `Image ${images.length + 1}`,
        ...(assetId ? { assetId } : {}),
      });
    };
    image('style', this.settings.styleImageUrl);
    image('initial frame', this.settings.initialImageUrl);
    if (this.sceneContext) {
      const certifiedNames = new Set(this.sceneContext.characterImages.map(character => character.characterName!));
      const missingName = names.find(name => !certifiedNames.has(name));
      if (missingName) throw new Error(`DSS character has no certified scene image: ${missingName}`);
      for (const name of names) {
        const character = this.sceneContext.characterImages.find(item => item.characterName === name)!;
        image(name, character.imageUrl, character.assetId);
      }
      image('set', this.sceneContext.setImage.imageUrl, this.sceneContext.setImage.assetId);
    } else {
      for (const name of names) image(name, this.characterReferences.get(normalize(name))?.imageUrl);
      image('set', state.backdropImageUrl ?? (state.set ? this.setReferences.get(normalize(state.set))?.imageUrl : undefined));
    }
    // Each shot contains one speaker. Other cast members need appearance grounding,
    // but their voice samples consume budget and can confuse speaker attribution.
    for (const name of line ? [line.speaker] : []) {
      const voice = this.characterReferences.get(normalize(name))?.voice;
      const exact = this.settings.useDialogueAudioReferences && line?.speaker === name && !split && line.audio && line.duration >= 2 && line.duration <= 15;
      const source = exact ? { url: line.audio!, durationSeconds: line.duration } : voice;
      if (source) {
        this.validateVoice(source, `${name} audio reference`);
        audios.push({ name, url: source.url, durationSeconds: source.durationSeconds, purpose: exact ? 'dialogue' : 'voice', label: `Audio ${audios.length + 1}` });
      }
    }
    if (images.length + audios.length > 12) throw new Error('Shot requires more than 12 combined image/audio references; reduce configured references');
    if (audios.length > 3) throw new Error('Shot requires more than 3 audio references; reduce configured voice references');
    if (audios.reduce((sum, entry) => sum + entry.durationSeconds, 0) > 15) throw new Error('Shot audio references exceed 15 seconds in total');
    return { images, audios };
  }

  private prompt(names: string[], refs: { images: PlannedImageReference[]; audios: PlannedAudioReference[] }, start: ShotPlannerState, end: ShotPlannerState, actions: readonly string[], camera: MutableState['camera'], line: Line | undefined, segment: DialogueSegment | undefined, duration: number): string {
    const imageFor = (name: string) => refs.images.find((entry) => entry.name === name)?.label;
    const subjects = names.map((name) => {
      const reference = this.characterReferences.get(normalize(name));
      const image = imageFor(name);
      const audio = refs.audios.find((entry) => entry.name === name);
      const audioInstruction = !audio ? undefined : audio.purpose === 'dialogue'
        ? `${audio.label} contains ${name}'s exact spoken performance for this line; match its words, timing, delivery and voice.`
        : `Use ${audio.label} only as ${name}'s voice identity and timbre reference; speak the scripted dialogue rather than copying the sample's words or timing.`;
      return [`${name}${image ? ` has the character design in ${image}` : ''}.`, reference?.description, end.characters[name]?.appearance, audioInstruction].filter(Boolean).join(' ');
    });
    const staging = (state: ShotPlannerState): string => names.map((name) => {
      const character = state.characters[name];
      if (!character) return '';
      if (character.certifiedPosition) return character.certifiedPosition;
      const place = character.mark ? this.markName(character.mark) : character.zone;
      return `${name} is ${character.posture}${place ? ` at ${place}` : ''}`;
    }).filter(Boolean).join('; ');
    const expressions = names.map((name) => {
      const character = end.characters[name];
      return [character?.gaze ? `${name} looks toward ${character.gaze}.` : '', character?.emotion ? `${name} appears ${character.emotion}.` : ''].filter(Boolean).join(' ');
    }).filter(Boolean);
    const tightShot = isCloseUp(camera.shot);
    const gazeTarget = line ? end.characters[line.speaker]?.gaze?.replace(/ \(eye contact\)$/, '') : undefined;
    const listener = line ? gazeTarget ? (names.includes(gazeTarget) ? gazeTarget : undefined) : line.respondent : undefined;
    const speakerInFrame = !camera.character || camera.character === line?.speaker;
    const eyeline = line && listener && listener !== line.speaker
      ? tightShot && speakerInFrame
        ? `${listener} is off-screen; ${line.speaker} addresses them with an eyeline just off-camera. Keep the camera on ${line.speaker}.`
        : tightShot
          ? `${line.speaker} speaks from off-screen while the camera holds on ${camera.character} listening silently.`
        : `${line.speaker} directs their eyeline toward ${listener}; keep the stated camera composition.`
      : '';
    const delivery = segment?.deliveryDirections.length ? `Delivery directions, not spoken text, in order: ${segment.deliveryDirections.join('; ')}.` : '';
    const setRef = end.set ? this.setReferences.get(normalize(end.set)) : undefined;
    const scene = [end.set, end.dressing, end.timeOfDay, setRef?.description].filter(Boolean).join(', ');
    const initialFrameOnly = this.settings.referenceMode === 'initial-frame';
    // A neutral style/set image may govern the world; a portrait governs only its
    // named character. Promoting a portrait to global style can blend identities.
    const styleImage = imageFor('style') ?? imageFor('set');
    const style = this.settings.styleDescription ?? (initialFrameOnly ? 'Preserve the visual medium and art style of the supplied initial frame.' : 'Coherent cinematic staging and expressive performances.');
    const initialImage = imageFor('initial frame');
    const cut = initialFrameOnly ? 'Continue from the supplied initial frame and preserve its camera framing.' : 'Hard cut into this camera setup; do not morph or dissolve between shots.';
    const blocking = actions.length ? 'Perform the scripted actions; otherwise hold the established character positions and camera framing.' : 'Hold the established character positions and camera framing throughout the shot.';
    return [
      `subject_definitions: ${subjects.join(' ')}`,
      `summary: ${scene ? `Setting: ${scene}. ` : ''}${style}${styleImage ? ` Use ${styleImage} for the overall rendering style.` : ''}`,
      ...(this.sceneContext ? [`certified_scene_context: ${sceneContextPrompt(this.sceneContext, refs.images)}`] : []),
      `set: ${scene || 'Preserve the established setting'}${imageFor('set') ? `; match the set design and lighting in ${imageFor('set')}` : ''}.`,
      `starting_state: ${staging(start) || 'Use the established staging.'}${initialFrameOnly ? ' The supplied initial frame provides the visual context; preserve its character designs, set and lighting.' : initialImage ? ` ${initialImage} is the supplied initial visual context.` : ''}`,
      `shot: ${CAMERA_NAMES[camera.shot] ?? humanize(camera.shot)}${camera.character ? ` of ${camera.character}` : ''}. ${cut} ${blocking} ${actions.join(' ')} ${expressions.join(' ')} ${eyeline} ${delivery}${line ? ` ${line.speaker}${line.tone ? `, speaking in a ${line.tone} tone,` : ''} speaks: <d>[English] ${segment!.dialogue}</d> Only ${line.speaker} speaks; any other characters listen silently.` : ''}`,
      `resulting_state: ${staging(end) || 'Preserve staging.'}`,
      `overall_soundscape: ${line ? 'Natural dialogue acoustics and quiet room tone.' : 'Quiet environmental ambience.'} Let the performance occupy the ${duration}-second shot without adding dialogue or captions.`,
    ].join('\n');
  }
}
