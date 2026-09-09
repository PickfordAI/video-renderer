import {
  BANISH_ZONE,
  BIBLE,
  compileWhispmaxPrompt,
  framingFor,
  isCloseUpFraming,
  type WhispmaxFraming,
  type WhispmaxShotInput,
} from './compile.js';

/**
 * PIC-1832: DSS → WhispMax clip packer. One prompt is one clip, so consecutive talk beats are
 * packed into a single generation while the same set and zone hold and the running duration
 * stays inside the endpoint's 15-second ceiling. Staging is tracked across the whole recording:
 * a Whispers payload re-establishes its set and cast before every line, so those preambles are
 * idempotent state, not clip boundaries.
 */
export const MIN_CLIP_SECONDS = 5;
export const MAX_CLIP_SECONDS = 15;
/** A beat of air after each line, as the prompting guide's timing note prescribes. */
export const BEAT_AIR_SECONDS = 0.3;
export const DEFAULT_BASE_SEED = 4242;

export interface WhispmaxSourceGroup {
  id: string;
  commands: readonly Record<string, unknown>[];
}

export interface WhispmaxSourcePayload {
  sequence: number;
  groups: readonly WhispmaxSourceGroup[];
  storyBlockId?: string;
}

export interface WhispmaxClipBeat {
  groupId: string;
  sequence: number;
  character: string;
  audioUrl?: string;
  audioDuration: number;
}

export interface WhispmaxClip {
  index: number;
  prompt: string;
  durationSeconds: number;
  seed: number;
  beats: WhispmaxClipBeat[];
  set: string | null;
  zone?: string;
  visibleCharacters: string[];
  storyBlockId?: string;
  warnings: string[];
}

export interface WhispmaxPlan {
  clips: WhispmaxClip[];
  /** Control-only groups that stay lead-in holds, exactly as the existing planner treats them. */
  holds: { sequence: number; groupId: string; durationSeconds: number }[];
  warnings: string[];
}

export interface PackOptions {
  baseSeed?: number;
  /** Inclusive payload sequence range; earlier payloads still replay staging. */
  from?: number;
  to?: number;
  episodeId?: number;
}

/** Groups that hold the picture without speech; they end the clip in progress. */
const HOLD_COMMANDS = new Set(['cutscene', 'showtitle', 'showcredits', 'credits']);
/** Timing/AV plumbing that repeats in every payload preamble and must not split a clip. */
const NEUTRAL_COMMANDS = new Set([
  'showdebug', 'setfps', 'playaudio', 'stopaudio', 'setchannelvolume', 'depthoffield',
  'showwhisper', 'fade', 'delay',
]);

function normalizeCommand(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[\s_-]+/g, '');
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function numeric(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

interface DialoguePart { dialogue: string; audioDuration: number }

/**
 * A single line longer than the ceiling becomes consecutive clips. Mirrors the existing
 * planner's rule: prefer a sentence boundary, never drop a spoken word.
 */
export function splitDialogue(dialogue: string, audioDuration: number, budgetSeconds = MAX_CLIP_SECONDS - BEAT_AIR_SECONDS): DialoguePart[] {
  if (audioDuration <= budgetSeconds) return [{ dialogue, audioDuration }];
  const tokens = words(dialogue);
  const secondsPerWord = audioDuration / tokens.length;
  const maximumWords = Math.floor(budgetSeconds / secondsPerWord);
  if (maximumWords < 1) throw new Error('Dialogue cannot be split into 15-second clips without word-level audio timing');
  const parts: DialoguePart[] = [];
  for (let offset = 0; offset < tokens.length;) {
    let length = Math.min(maximumWords, tokens.length - offset);
    if (offset + length < tokens.length) {
      for (let candidate = length; candidate >= Math.ceil(length / 2); candidate--) {
        // A cue bracket is a delivery marker, not a sentence end; keep it with its text.
        if (/[.!?]["'”’)\]]*$/.test(tokens[offset + candidate - 1]) && !/\]$/.test(tokens[offset + candidate - 1])) {
          length = candidate;
          break;
        }
      }
    }
    parts.push({ dialogue: tokens.slice(offset, offset + length).join(' '), audioDuration: length * secondsPerWord });
    offset += length;
  }
  return parts;
}

export function clipDurationFor(weightSeconds: number): number {
  return Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, Math.ceil(Math.round(weightSeconds * 1000) / 1000)));
}

interface Draft {
  set: string | null;
  zone?: string;
  storyBlockId?: string;
  shots: WhispmaxShotInput[];
  beats: WhispmaxClipBeat[];
  weight: number;
}

interface Beat {
  character: string;
  dialogue: string;
  framing: WhispmaxFraming;
  cameraUpdate: boolean;
  lookTarget?: string;
  emotion?: string;
  animations: string[];
  tone?: string;
  visibleCharacters: string[];
  audioUrl?: string;
  audioDuration: number;
  groupId: string;
  sequence: number;
  set: string | null;
  zone?: string;
  storyBlockId?: string;
}

export function packWhispmaxClips(
  payloads: readonly WhispmaxSourcePayload[],
  options: PackOptions = {},
): WhispmaxPlan {
  const baseSeed = options.baseSeed ?? DEFAULT_BASE_SEED;
  const plan: WhispmaxPlan = { clips: [], holds: [], warnings: [] };
  const zones = new Map<string, string | undefined>();
  let set: string | null = null;
  let draft: Draft | null = null;

  const flush = (): void => {
    const pending = draft;
    draft = null;
    if (!pending) return;
    const durationSeconds = clipDurationFor(pending.weight);
    const compiled = compileWhispmaxPrompt({
      set: pending.set, ...(pending.zone === undefined ? {} : { zone: pending.zone }),
      shots: pending.shots, durationSeconds,
    });
    plan.clips.push({
      index: plan.clips.length,
      prompt: compiled.prompt,
      durationSeconds,
      seed: baseSeed + plan.clips.length,
      beats: pending.beats,
      set: pending.set,
      ...(pending.zone === undefined ? {} : { zone: pending.zone }),
      visibleCharacters: compiled.visibleCharacters,
      ...(pending.storyBlockId === undefined ? {} : { storyBlockId: pending.storyBlockId }),
      warnings: compiled.warnings,
    });
    plan.warnings.push(...compiled.warnings.map(warning => `clip ${plan.clips.length}: ${warning}`));
  };

  const append = (beat: Beat, dialogue: string, audioDuration: number): void => {
    const weight = audioDuration + BEAT_AIR_SECONDS;
    let target = draft;
    if (target && (target.set !== beat.set || target.zone !== beat.zone || target.weight + weight > MAX_CLIP_SECONDS)) {
      flush();
      target = null;
    }
    if (!target) {
      target = {
        set: beat.set, ...(beat.zone === undefined ? {} : { zone: beat.zone }),
        ...(beat.storyBlockId === undefined ? {} : { storyBlockId: beat.storyBlockId }),
        shots: [], beats: [], weight: 0,
      };
      draft = target;
    }
    target.shots.push({
      character: beat.character,
      dialogue,
      framing: beat.framing,
      // The first shot of a clip carries the establishing framing sentence, never a cut.
      cameraUpdate: beat.cameraUpdate,
      ...(beat.lookTarget === undefined ? {} : { lookTarget: beat.lookTarget }),
      ...(beat.emotion === undefined ? {} : { emotion: beat.emotion }),
      animations: beat.animations,
      ...(beat.tone === undefined ? {} : { tone: beat.tone }),
      visibleCharacters: beat.visibleCharacters,
      weightSeconds: weight,
    });
    target.beats.push({
      groupId: beat.groupId, sequence: beat.sequence, character: beat.character,
      ...(beat.audioUrl === undefined ? {} : { audioUrl: beat.audioUrl }),
      audioDuration,
    });
    target.weight += weight;
  };

  for (const payload of payloads) {
    const inRange = (options.from === undefined || payload.sequence >= options.from)
      && (options.to === undefined || payload.sequence <= options.to);
    for (const group of payload.groups) {
      const names = group.commands.map(command => normalizeCommand(command.command));
      let hold = 0;
      let holdSeconds = 0;
      const beats: Beat[] = [];
      // `look` / `set emotion` / `play animation` sit in the talk's own group in these recordings,
      // and DSS emits them after the talk, so performance state is collected per character across
      // the whole group and attached once the group is complete.
      interface Performance { lookTarget?: string; emotion?: string; animations: string[] }
      const performance = new Map<string, Performance>();
      const performanceFor = (character: string): Performance => {
        const existing = performance.get(character);
        if (existing) return existing;
        const created: Performance = { animations: [] };
        performance.set(character, created);
        return created;
      };

      for (const command of group.commands) {
        const name = normalizeCommand(command.command);
        const args = object(command.args ?? command.content);
        if (HOLD_COMMANDS.has(name)) {
          hold += 1;
          holdSeconds = Math.max(holdSeconds, numeric(args.duration) ?? numeric(args.duration_seconds) ?? 0);
          continue;
        }
        if (NEUTRAL_COMMANDS.has(name)) continue;
        switch (name) {
          case 'enableset': {
            const next = text(args.set) ?? null;
            if (next !== set) { flush(); zones.clear(); }
            set = next;
            break;
          }
          case 'addcharacter': case 'spawncharacter': {
            const who = text(args.name) ?? text(args.character);
            if (who) zones.set(who, text(args.zone ?? object(args.point).zone));
            break;
          }
          case 'removecharacter': case 'despawncharacter': {
            const who = text(args.name) ?? text(args.character);
            if (who) zones.delete(who);
            break;
          }
          case 'charactermoveto': {
            const who = text(args.character);
            const zone = text(object(args.location).zone);
            if (who && zone) zones.set(who, zone);
            break;
          }
          case 'look': {
            const who = text(args.character);
            const target = text(object(args.target).name) ?? text(args.target);
            if (who && target) performanceFor(who).lookTarget = target;
            break;
          }
          case 'setemotion': {
            const who = text(args.character);
            const emotion = text(args.emotion);
            // `neutral` is the absence of an expression note, not an expression.
            if (who && emotion && emotion.toLowerCase() !== 'neutral') performanceFor(who).emotion = emotion;
            break;
          }
          case 'playanimation': {
            const who = text(args.character);
            const animation = text(args.animation);
            if (who && animation) performanceFor(who).animations.push(animation);
            break;
          }
          case 'talk': case 'charactertalk': {
            const character = text(args.character);
            const dialogue = text(args.dialogue);
            const audioDuration = numeric(args.audio_duration);
            if (!character || !dialogue) {
              plan.warnings.push(`sequence ${payload.sequence} group ${group.id}: talk without a character or dialogue`);
              break;
            }
            const cameraShot = text(args.camera_shot);
            const { framing, known } = framingFor(cameraShot);
            if (!known) plan.warnings.push(`sequence ${payload.sequence}: unmapped camera_shot ${cameraShot}`);
            const zone = zones.get(character);
            const respondent = text(args.respondent);
            const visible = [character];
            // Conservative frame rule: a second face only on a wider shot, only the addressed
            // character, and only when staging puts them in the same zone.
            if (!isCloseUpFraming(framing) && respondent && respondent !== character
              && zones.has(respondent) && zones.get(respondent) === zone && zone !== BANISH_ZONE) {
              visible.push(respondent);
            }
            beats.push({
              character, dialogue, framing,
              cameraUpdate: args.camera_update !== false,
              animations: [],
              ...(text(args.tone) === undefined ? {} : { tone: text(args.tone) }),
              visibleCharacters: visible,
              ...(text(args.audio) === undefined ? {} : { audioUrl: text(args.audio) }),
              audioDuration: audioDuration && audioDuration > 0 ? audioDuration : words(dialogue).length / 2.3,
              groupId: group.id, sequence: payload.sequence,
              set, ...(zone === undefined || zone === BANISH_ZONE ? {} : { zone }),
              ...(payload.storyBlockId === undefined ? {} : { storyBlockId: payload.storyBlockId }),
            });
            break;
          }
          default:
            plan.warnings.push(`sequence ${payload.sequence} group ${group.id}: unsupported DSS command ${String(command.command)}`);
        }
      }

      for (const beat of beats) {
        const state = performance.get(beat.character);
        if (!state) continue;
        if (state.lookTarget !== undefined) beat.lookTarget = state.lookTarget;
        if (state.emotion !== undefined) beat.emotion = state.emotion;
        beat.animations = [...state.animations];
      }
      if (!inRange) continue;
      if (hold > 0 && names.every(name => HOLD_COMMANDS.has(name) || NEUTRAL_COMMANDS.has(name))) {
        flush();
        plan.holds.push({ sequence: payload.sequence, groupId: group.id, durationSeconds: holdSeconds });
        continue;
      }
      for (const beat of beats) {
        const parts = splitDialogue(beat.dialogue, beat.audioDuration);
        if (parts.length > 1) flush();
        for (const part of parts) {
          append(beat, part.dialogue, part.audioDuration);
          if (parts.length > 1) flush();
        }
      }
    }
  }
  flush();
  return plan;
}

/** Bible coverage is a plan-time report, not a hard failure; the LoRA renders in style regardless. */
export function outOfBibleWarnings(plan: WhispmaxPlan): string[] {
  return plan.warnings.filter(warning => warning.includes('outside the WhispMax bible'));
}

export function bibleHasCharacter(name: string): boolean {
  return Boolean(BIBLE.characters[name]);
}
