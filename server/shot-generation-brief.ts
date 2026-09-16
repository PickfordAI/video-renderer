import type { ShotBrief } from './shot-brief.js';
import { relativeShotDirection, type RelativeShotDirection } from './shot-directions.js';

export type GenerationCast = ShotBrief['visibleCast'][number] & {
  description: string;
  placementCoordinateSpace: 'room-relative';
  gazeProvenance?: string;
  emotionProvenance?: string;
};
export interface ShotGenerationBrief extends Omit<ShotBrief, 'source' | 'visibleCast' | 'speech'> {
  visibleCast: GenerationCast[];
  speech?: NonNullable<ShotBrief['speech']> & { respondent?: string };
  camera: { framing: string; subject?: string; source: string; behavior: string; behaviorSource: string };
  relationships: Array<{ actor: string; relation: 'looks-at' | 'addresses'; target: string; targetPlacement?: string; targetDirection?: RelativeShotDirection; source: string }>;
  endingChanges: string[];
  continuity: { requiresPreviousFrame: boolean; hasMovement: boolean };
  sound: { description: string; source: string };
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const specialTarget = /^(?:camera|lens|viewer|floor|ground|sky|ceiling|(?:toward )?(?:camera|screen|frame)[ -](?:left|right))$/i;
const finish = (text: string) => text.trim().replace(/[.\s]+$/, '');

/** Small semantic rewrites for known source phrasings; never drop a clause just for a hidden name. */
export function affirmativeSourceText(text: string): string {
  return text
    .replace(/\bwithout (?:his|her|their|a|the) coat\b/gi, 'coatless')
    .replace(/\bwithout (?:a |his |her |their |the )?hat\b/gi, 'bareheaded')
    .replace(/\bwithout (?:any )?dialogue\b/gi, 'silently')
    .replace(/\b(?:do not|don't) move (?:the )?camera\b/gi, 'hold the camera framing')
    .replace(/\b(?:no walking|do not walk)\b/gi, 'remain at the authored location')
    .split(/(?<=[.!?])\s+/)
    // An unseen furnishing is retained internally; its existence is not a request to put it in the shot.
    .filter(c => !/^(?:the )?(?:door|window|hallway|staircase)\b.*\boutside (?:this|the) (?:view|frame)\b/i.test(c))
    .join(' ');
}

/** Preserve semantic clauses while substituting hidden names at the output boundary. */
export function projectShotBrief(brief: ShotBrief, options: { annotateHiddenDirections?: boolean } = {}): ShotGenerationBrief {
  const raw = brief.source;
  const visible = new Set(raw.subjects.filter(s => s.visible).map(s => s.name));
  const speaker = raw.speech?.speaker;
  const hiddenNames = [...new Set([
    ...raw.subjects.filter(s => !s.visible && s.name !== speaker).map(s => s.name),
    ...[raw.speech?.respondent, raw.speech?.listener].filter((s): s is string => Boolean(s) && !visible.has(s!) && s !== speaker && !specialTarget.test(s!) && !/^(?:unknown|none)$/i.test(s!)),
  ])];
  const aliases = new Map(hiddenNames.map((name, i) => [name, i === 0 ? 'the person beyond the frame' : `the other person beyond the frame${i > 1 ? ` (${i + 1})` : ''}`]));
  const rename = (value?: string) => {
    let result = value ?? '';
    for (const name of [...hiddenNames].sort((a, b) => b.length - a.length)) {
      result = result.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, 'gu'), aliases.get(name)!);
    }
    return finish(affirmativeSourceText(result).replace(/\b(?:set:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '').replace(/\s{2,}/g, ' '));
  };
  const { source: _source, ...legacy } = brief;
  const directionTo = (actor: string, target?: string) => {
    const from = raw.subjects.find(s => s.name === actor);
    const to = raw.subjects.find(s => s.name === target);
    const direction = from && to ? relativeShotDirection(from.resultingBlocking ?? '', to.resultingBlocking ?? '') : undefined;
    return direction ? { ...direction, performerAnchor: rename(direction.performerAnchor), targetAnchor: rename(direction.targetAnchor) } : undefined;
  };
  // Each actor gets its own target-relative annotation. A shared alias alone loses direction.
  const renameFor = (actor: string, value?: string) => {
    if (options.annotateHiddenDirections === false) return rename(value);
    let result = value ?? '';
    for (const name of [...hiddenNames].sort((a, b) => b.length - a.length)) {
      const direction = directionTo(actor, name);
      if (!direction) continue;
      result = result.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, 'gu'),
        `${aliases.get(name)} (toward room-${direction.horizontal} from ${actor}'s position)`);
    }
    return rename(result);
  };
  const relationships: ShotGenerationBrief['relationships'] = [];
  const endingChanges: string[] = [];
  const cast = raw.subjects.filter(s => s.visible).map(s => {
    const old = brief.visibleCast.find(c => c.name === s.name)!;
    const target = s.gaze?.replace(/ \(eye contact\)$/, '') ?? (s.name === speaker ? raw.speech?.respondent ?? raw.speech?.listener : undefined);
    const targetSubject = raw.subjects.find(c => c.name === target);
    let eyeline = old.eyeline;
    let gaze = { ...old.gaze };
    if (targetSubject) {
      if (!s.gazeDirection) eyeline = `toward ${renameFor(s.name, target)}`;
      if (!s.gazeDirection) gaze = { ...gaze, target: targetSubject.visible ? 'visible-character' : 'off-frame-character',
        directionSource: targetSubject.visible ? 'authored' : brief.composition ? 'composition-inference-required' : 'unspecified',
        targetPlacement: rename(targetSubject.resultingBlocking), performerPlacement: rename(s.resultingBlocking) };
      gaze.targetDirection = directionTo(s.name, target);
      relationships.push({ actor: s.name, relation: 'looks-at', target: renameFor(s.name, target), targetPlacement: rename(targetSubject.resultingBlocking), targetDirection: directionTo(s.name, target), source: s.gaze ? s.gazeSource ?? 'persistent-dss' : 'dialogue-respondent-inference' });
    }
    const changes: string[] = [];
    if (s.resultingPosture && s.resultingPosture !== 'as authored' && s.resultingPosture !== s.startingPosture) changes.push(rename(s.resultingPosture));
    if (s.resultingBlocking && s.resultingBlocking !== s.startingBlocking) changes.push(rename(s.resultingBlocking));
    if (s.gaze && s.gaze !== s.startingGaze) changes.push(`${s.name} looks ${eyeline}`);
    if (s.emotion && s.emotion !== s.startingEmotion) changes.push(`${s.name} appears ${rename(s.emotion)}`);
    const startAppearance = raw.startingState.characters[s.name]?.appearance;
    if (s.appearance && startAppearance && s.appearance !== startAppearance) changes.push(`${s.name}: ${rename(s.appearance)}`);
    if (changes.length) endingChanges.push(`${s.name}: ${changes.join('. ')}`);
    const description = /^Body orientation:/i.test(s.description ?? '') ? '' : rename(s.description);
    const orientation = s.bodyOrientation ?? (/^Body orientation:/i.test(s.description ?? '') ? s.description!.replace(/^Body orientation:\s*/i, '') : '');
    return { ...old, description, placementCoordinateSpace: 'room-relative' as const, appearance: rename(s.appearance), bodyOrientation: renameFor(s.name, orientation),
      posture: s.startingPosture === 'as authored' ? '' : rename(s.startingPosture), placement: rename(s.startingBlocking),
      ending: changes.join('. '), eyeline, gaze, emotion: rename(s.emotion), gazeProvenance: s.gazeSource, emotionProvenance: s.emotionSource };
  });
  const speech = raw.speech ? { speaker: raw.speech.speaker, visible: visible.has(raw.speech.speaker), dialogue: raw.speech.dialogue,
    tone: rename(raw.speech.tone), respondent: /^(?:unknown|none)$/i.test(raw.speech.respondent ?? '') ? undefined : renameFor(raw.speech.speaker, raw.speech.respondent) || undefined,
    deliveryBeats: (raw.speech.deliveryBeats ?? [{ phrase: raw.speech.dialogue, directions: raw.speech.deliveryDirections }]).map(b => ({ phrase: b.phrase, directions: b.directions.map(rename) })) } : undefined;
  if (speech?.respondent) relationships.push({ actor: speech.speaker, relation: 'addresses', target: speech.respondent,
    targetPlacement: rename(raw.subjects.find(s => s.name === raw.speech?.respondent)?.resultingBlocking), targetDirection: directionTo(speech.speaker, raw.speech?.respondent), source: 'explicit-dss' });
  const setting = [...new Set([rename(raw.sceneName), ...raw.sceneAtmosphere.map(rename), rename(raw.sceneDescription)].filter(Boolean))].join('. ') || rename(raw.scene);
  return { ...legacy, setting, style: rename(raw.styleDescription), visibleCast: cast, speech,
    actions: raw.actions.map(rename).filter(Boolean), relationships, endingChanges,
    camera: { framing: rename(raw.camera.framing), subject: raw.camera.target && visible.has(raw.camera.target) ? raw.camera.target : undefined,
      source: raw.camera.source, behavior: raw.defaults.cameraBehavior, behaviorSource: raw.defaults.source },
    continuity: { requiresPreviousFrame: raw.continuity.requiresPreviousFrame, hasMovement: raw.continuity.hasMovement },
    sound: { description: raw.defaults.soundscape, source: raw.defaults.source },
  };
}
