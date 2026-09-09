import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PIC-1832: the WhispMax LoRA prompt compiler. The LoRA was trained on captions with a
 * fixed five-part structure, so this module reproduces that structure literally from the
 * prompting guide: trigger line, `[characters]`, `[Location]`, `[style]`, `[prompt]`.
 *
 * Pure by construction — no provider calls, no network, no scheduling. `bible.json` is read
 * once at module load; everything below is a string transform over caller-supplied beats.
 */
export interface WhispmaxZoneEntry {
  /** Human zone name for the `[Location]` line; `hallway.1` and `hallway.2` are both `hallway`. */
  label: string;
  description: string;
}

export interface WhispmaxBible {
  trigger: string;
  style: string;
  characters: Record<string, string>;
  sets: Record<string, string>;
  /** Keyed `<set>|<JSON zone value>`, so a zone name is only meaningful inside its set. */
  zones: Record<string, WhispmaxZoneEntry>;
}

export const BIBLE: WhispmaxBible = JSON.parse(
  readFileSync(join(import.meta.dirname, 'bible.json'), 'utf8'),
) as WhispmaxBible;

export const WHISPMAX_TRIGGER = BIBLE.trigger;

/** The trained wordings. Raw labels the guide does not list are omitted rather than invented. */
export const ANIMATION_PHRASES: Readonly<Record<string, string>> = {
  'embarassed talking': 'speaks with embarrassment',
  'one hand gesture': 'gestures with one hand',
  'two hand gesture': 'gestures with both hands',
  'finger point': 'points a finger',
  'hands on hips': 'holds both hands on the hips',
  'look away': 'looks away',
  thinking: 'appears thoughtful',
  paranoid: 'acts warily',
  angry: 'acts angrily',
  sarcastic: 'acts sarcastically',
  embarrassed: 'appears embarrassed',
  talking: '',
};

export type WhispmaxFraming = 'Close-up' | 'Medium shot' | 'Full shot';

const CAMERA_FRAMINGS: Readonly<Record<string, WhispmaxFraming>> = {
  Character_CloseUp: 'Close-up',
  Character_ExtremeCloseUp: 'Close-up',
  Character_Medium: 'Medium shot',
  Character_Full: 'Full shot',
};

/** DSS stages off-stage cast in this sentinel zone; it is not a location. */
export const BANISH_ZONE = 'banish';

export function framingFor(cameraShot: string | undefined): { framing: WhispmaxFraming; known: boolean } {
  if (!cameraShot) return { framing: 'Medium shot', known: true };
  const framing = CAMERA_FRAMINGS[cameraShot];
  return framing ? { framing, known: true } : { framing: 'Medium shot', known: false };
}

export function isCloseUpFraming(framing: WhispmaxFraming): boolean {
  return framing === 'Close-up';
}

export interface DeliverySegment {
  /** The `[cue]` that governs this quoted part; absent when the line opens with no cue. */
  cue?: string;
  text: string;
}

/**
 * `"[uneasy] I don't know."` → one segment cued `uneasy`. Consecutive duplicate cues collapse
 * into a single quoted part, which is also what makes the delivery summary read as the guide's
 * `shifts from firm to tense to disbelieving`.
 */
/**
 * The trained captions use one- or two-word delivery cues, but StoryKernel also writes whole
 * stage directions in brackets (`[dry half to himself taking in the marble]`). A long direction
 * is reduced to its leading adverb so the sentence stays the grammar the LoRA learned; the
 * direction is never spoken either way.
 */
export function deliveryCue(raw: string): string {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  return parts.length <= 3 ? parts.join(' ') : parts[0];
}

export function parseDeliverySegments(raw: string, fallbackCue?: string): DeliverySegment[] {
  const segments: DeliverySegment[] = [];
  let cue = fallbackCue ? deliveryCue(fallbackCue) : undefined;
  let offset = 0;
  const push = (text: string, segmentCue: string | undefined): void => {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    const previous = segments.at(-1);
    if (previous && previous.cue === segmentCue) previous.text = `${previous.text} ${trimmed}`;
    else segments.push({ ...(segmentCue ? { cue: segmentCue } : {}), text: trimmed });
  };
  for (const match of raw.matchAll(/\[([^\]]*)\]/g)) {
    push(raw.slice(offset, match.index), cue);
    const next = match[1].trim();
    if (next) cue = deliveryCue(next);
    offset = match.index + match[0].length;
  }
  push(raw.slice(offset), cue);
  return segments;
}

export interface WhispmaxShotInput {
  character: string;
  /** Raw DSS dialogue, `[cue]` markers included; the quoted text stays verbatim. */
  dialogue: string;
  framing: WhispmaxFraming;
  /** `camera_update` on a follow-on beat: a real cut rather than a two-shot handoff. */
  cameraUpdate: boolean;
  /** `look` target; rewritten to `turns toward the viewer` when it is not in this shot's frame. */
  lookTarget?: string;
  /** `set emotion`; `neutral` must already be dropped by the caller. */
  emotion?: string;
  animations?: readonly string[];
  /** `talk.tone`, the delivery cue of last resort. */
  tone?: string;
  /** Who is in frame for THIS shot; drives the gaze rule and the clip's `[characters]` list. */
  visibleCharacters: readonly string[];
  /** Weight used to tile the clip's shot timestamps (audio duration plus a beat of air). */
  weightSeconds: number;
}

export interface WhispmaxClipInput {
  set: string | null;
  /** Raw DSS zone value (`waiting room`, `hallway.2`, `room.suite`), not the display label. */
  zone?: string;
  shots: readonly WhispmaxShotInput[];
  durationSeconds: number;
}

export interface CompiledPrompt {
  prompt: string;
  /** Clip-level `[characters]` list, in first-appearance order. */
  visibleCharacters: string[];
  warnings: string[];
}

function seconds(value: number): string {
  return value.toFixed(3);
}

/** `a`, `a and b`, `a, b and c` — the guide's action-sentence joiner. */
function joinActions(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function lowercaseFraming(framing: WhispmaxFraming): string {
  return framing.toLowerCase();
}

export interface ResolvedLocation {
  line: string;
  /** Zone display label, or the set name when the zone is the set itself or unknown. */
  label: string;
  warnings: string[];
}

/** `set — zone - <desc>`, or `set - <desc>` when the zone is the set itself or unknown. */
export function resolveLocation(set: string | null, zone: string | undefined): ResolvedLocation {
  const warnings: string[] = [];
  if (!set) return { line: '', label: '', warnings: ['Clip has no enabled set; the [Location] line is omitted'] };
  const setDescription = BIBLE.sets[set];
  if (!setDescription) warnings.push(`Set outside the WhispMax bible: ${set}`);
  const entry = zone === undefined || zone === BANISH_ZONE ? undefined : BIBLE.zones[`${set}|${zone}`];
  if (zone !== undefined && zone !== BANISH_ZONE && !entry) {
    warnings.push(`Zone outside the WhispMax bible: ${set} / ${zone}; falling back to the whole-set entry`);
  }
  if (!entry) {
    return {
      line: setDescription ? `${set} - ${setDescription}` : `${set} - `,
      label: set,
      warnings,
    };
  }
  const line = entry.label === set
    ? `${set} - ${entry.description}`
    : `${set} — ${entry.label} - ${entry.description}`;
  return { line, label: entry.label, warnings };
}

export function compileWhispmaxPrompt(clip: WhispmaxClipInput): CompiledPrompt {
  if (clip.shots.length === 0) throw new Error('A WhispMax clip needs at least one shot');
  if (!Number.isInteger(clip.durationSeconds) || clip.durationSeconds < 5 || clip.durationSeconds > 15) {
    throw new Error('A WhispMax clip duration must be an integer from 5 to 15 seconds');
  }
  const location = resolveLocation(clip.set, clip.zone);
  const warnings = [...location.warnings];
  const zoneClause = location.label && location.label !== clip.set ? `, in the ${location.label} area` : '';
  const setClause = clip.set ? ` in the ${clip.set}` : '';

  const visibleCharacters: string[] = [];
  for (const shot of clip.shots) {
    for (const name of [shot.character, ...shot.visibleCharacters]) {
      if (!visibleCharacters.includes(name)) visibleCharacters.push(name);
    }
  }
  for (const name of visibleCharacters) {
    if (!BIBLE.characters[name]) warnings.push(`Character outside the WhispMax bible: ${name}`);
  }

  const paragraphs: string[] = [];
  let elapsed = 0;
  clip.shots.forEach((shot, index) => {
    const start = elapsed;
    elapsed = index === clip.shots.length - 1
      ? clip.durationSeconds
      : Math.min(clip.durationSeconds, Math.round((start + shot.weightSeconds) * 1000) / 1000);
    const framing = index === 0
      ? `${shot.framing} of ${shot.character}${setClause}${zoneClause}.`
      : shot.cameraUpdate
        ? `The camera cuts to a ${lowercaseFraming(shot.framing)} of ${shot.character}${setClause}${zoneClause}.`
        : `Still in the same frame, ${lowercaseFraming(shot.framing)} of ${shot.character}${setClause}${zoneClause}.`;

    const segments = parseDeliverySegments(shot.dialogue, shot.tone);
    if (segments.length === 0) throw new Error(`Shot for ${shot.character} has no spoken dialogue`);
    const cues = segments.map(segment => segment.cue).filter((cue): cue is string => Boolean(cue));

    const actionParts: string[] = [];
    if (shot.lookTarget && shot.lookTarget !== shot.character) {
      // Hard rule 1: an off-screen character is never named in the prose.
      actionParts.push(shot.visibleCharacters.includes(shot.lookTarget)
        ? `looks toward ${shot.lookTarget}`
        : 'turns toward the viewer');
    }
    for (const animation of shot.animations ?? []) {
      const phrase = ANIMATION_PHRASES[animation];
      if (phrase) actionParts.push(phrase);
    }
    // Only `set emotion` becomes `appears <emotion>`. `tone` is the delivery-cue fallback the
    // guide's command table describes, not a second source of visible affect.
    if (shot.emotion) actionParts.push(`appears ${shot.emotion}`);
    const actions = actionParts.length ? `${shot.character} ${joinActions(actionParts)}.` : '';

    const delivery = cues.length === 0
      ? ''
      : cues.length === 1
        ? `${shot.character} speaks with ${cues[0]} delivery.`
        : `${shot.character} speaks with delivery that shifts from ${cues.join(' to ')}.`;

    const quoted = segments.map((segment, position) => position === 0
      ? segment.cue
        ? `${shot.character} says with ${segment.cue} delivery, “${segment.text}”`
        : `${shot.character} says, “${segment.text}”`
      : segment.cue
        ? `With ${segment.cue} delivery: “${segment.text}”`
        : `“${segment.text}”`).join(' ');

    const prose = [framing, actions, delivery, quoted].filter(Boolean).join(' ');
    paragraphs.push(`Shot ${index + 1} [${seconds(start)}–${seconds(elapsed)} seconds]: ${prose}`);
  });

  const prompt = [
    WHISPMAX_TRIGGER,
    '[characters]',
    ...visibleCharacters.map(name => `${name} - ${BIBLE.characters[name] ?? name}`),
    '[Location]',
    location.line,
    '[style]',
    `WhispMax style - ${BIBLE.style}`,
    '[prompt]',
    paragraphs.join('\n\n'),
  ].filter(line => line !== '').join('\n');

  return { prompt, visibleCharacters, warnings };
}
