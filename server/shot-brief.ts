import type { PlannedShot, ShotPlannerState } from './shot-planner.js';
import { selectShotPromptReferences, type ShotPromptInput } from './shot-prompt.js';
import type { RelativeShotDirection } from './shot-directions.js';

const negative = /\b(?:no|not|never|without|avoid|exclude|excluding|instead|rather than|don['’]t|doesn['’]t|isn['’]t|aren['’]t|shouldn['’]t|mustn['’]t|can['’]t|won['’]t)\b|\boff[ -]?screen\b|\boutside (?:the |this )?(?:frame|view|shot)\b/i;
const mentions = (text: string, name: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
const sentence = (text: string) => text.trim().replace(/[.\s]+$/, '');

export interface ShotGaze {
  source: 'dss-look' | 'speech-listener' | 'unspecified';
  target: 'visible-character' | 'off-frame-character' | 'direction' | 'unspecified';
  directionSource: 'authored' | 'composition-inference-required' | 'unspecified';
  /** Room-relative DSS evidence, not a screen-direction assertion. */
  targetPlacement?: string;
  performerPlacement?: string;
  targetDirection?: RelativeShotDirection;
}

/** Lossless semantic input retained before generation-facing name/prose filtering. */
export interface ShotBriefSource {
  subjects: ShotPromptInput['subjects'];
  scene: string;
  sceneName?: string;
  sceneDescription?: string;
  sceneAtmosphere: readonly string[];
  styleDescription?: string;
  speech?: ShotPromptInput['speech'];
  actions: readonly string[];
  camera: { framing: string; target?: string; tightShot: boolean; source: 'explicit-dss' | 'persistent-dss' | 'planner-default'; preparedComposition?: string };
  startingState: ShotPlannerState;
  resultingState: ShotPlannerState;
  recordedSceneState?: Record<string, unknown>;
  commandEvidence: NonNullable<ShotPromptInput['commandEvidence']>;
  referenceOwnership: Array<{ label: string; name: string; role: string; assetId?: string; sourceId?: string; description?: string; durationSeconds?: number }>;
  continuity: { setupKey: string; continuityKey: string; requiresPreviousFrame: boolean; hasMovement: boolean };
  defaults: { cameraBehavior: 'fixed'; soundscape: 'quiet room tone'; source: 'formatter-default' };
}

/** Camera-specific brief plus retained authoring evidence for either generation branch. */
export interface ShotBrief {
  source: ShotBriefSource;
  durationSeconds: number;
  framing: string;
  setting: string;
  style: string;
  composition?: string;
  visibleCast: Array<{ name: string; picture?: string; appearance: string; bodyOrientation: string; posture: string; placement: string; ending: string; eyeline: string; gaze: ShotGaze; emotion: string }>;
  references: Array<{ label: string; name: string; role: string }>;
  audioReferences: Array<{ label: string; name: string; purpose: string }>;
  actions: string[];
  speech?: { speaker: string; visible: boolean; dialogue: string; tone: string; deliveryBeats: Array<{ phrase: string; directions: string[] }> };
}

export function buildShotBrief(shot: PlannedShot): ShotBrief {
  const input = shot.promptInput;
  if (input.initialFrameOnly) throw new Error('Prompt trial currently supports reference-to-video shots');
  const refs = selectShotPromptReferences(input, shot.imageReferences, shot.audioReferences);
  const visible = input.subjects.filter(s => s.visible);
  const names = new Set(visible.map(s => s.name));
  const hidden = [...new Set([...input.subjects.filter(s => !s.visible).map(s => s.name), ...[input.speech?.listener, input.speech?.speaker].filter((n): n is string => Boolean(n) && !names.has(n!))])];
  // Drop complete disallowed clauses; removing the negative token could reverse their meaning.
  const positive = (value?: string) => (value ?? '').split(/(?<=[.!?])\s+|[;\n]+/)
    .filter(c => c.trim() && !negative.test(c) && !hidden.some(n => mentions(c, n)))
    .map(c => sentence(c.replace(/\b(?:set:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'referenced setting'))).join('. ');
  const orientation = (value?: string) => (value ?? '').split(/\s*,\s*|\s+with\s+/).map(positive).filter(Boolean).join(', ');
  const anchor = refs.images.findIndex(r => r.role === 'composition' || r.role === 'camera-anchor');
  const composition = anchor >= 0 ? `Image ${anchor + 1}` : undefined;
  const directional = /^(?:(?:toward|to) )?(?:camera[ -](?:left|right)|screen[ -](?:left|right)|(?:just |slightly )?(?:left|right) of (?:the )?(?:camera|lens)|(?:just )?(?:above|below) (?:the )?(?:camera|lens)|into (?:the )?(?:camera|lens))$/i;
  const attention = (subject: typeof visible[number]): { eyeline: string; gaze: ShotGaze } => {
    const target = subject.gaze?.replace(/ \(eye contact\)$/, '') ?? (subject.name === input.speech?.speaker ? input.speech.listener : undefined);
    const source: ShotGaze['source'] = subject.gaze || subject.gazeDirection ? 'dss-look' : target ? 'speech-listener' : 'unspecified';
    const result = (eyeline: string, kind: ShotGaze['target'], directionSource: ShotGaze['directionSource']): { eyeline: string; gaze: ShotGaze } => ({ eyeline, gaze: { source, target: kind, directionSource } });
    if (positive(subject.gazeDirection)) return result(positive(subject.gazeDirection), 'direction', 'authored');
    if (target && names.has(target)) return result(`toward ${target}`, 'visible-character', 'authored');
    if (target && directional.test(target)) return result(positive(target), 'direction', 'authored');
    if (target && /^(floor|ground)$/i.test(target)) return result('downward toward the ground', 'direction', 'authored');
    if (target && /^(sky|ceiling)$/i.test(target)) return result('upward', 'direction', 'authored');
    if (target && /^(camera|lens|viewer)$/i.test(target)) return result('into the camera', 'direction', 'authored');
    if (target && /^(?:unknown|none)$/i.test(target)) return result(composition ? `in the direction established by ${composition}` : '', 'unspecified', 'unspecified');
    if (target && !input.subjects.some(s => s.name === target)) return result(`toward ${positive(target)}`, 'direction', 'authored');
    if (target) {
      // Preserve the relationship before removing its name. Room marks alone do not establish screen direction.
      const resolved = result('toward the person beyond the frame', 'off-frame-character', composition ? 'composition-inference-required' : 'unspecified');
      const anonymize = (value?: string) => {
        let prose = value ?? '';
        for (const s of [...input.subjects].sort((a, b) => b.name.length - a.name.length)) {
          prose = prose.split(s.name).join(s.name === target ? 'the gaze target' : s.name === subject.name ? 'the performer' : 'another scene character');
        }
        return positive(prose);
      };
      resolved.gaze.targetPlacement = anonymize(input.subjects.find(s => s.name === target)?.resultingBlocking);
      resolved.gaze.performerPlacement = anonymize(subject.resultingBlocking);
      return resolved;
    }
    return result(composition ? `in the direction established by ${composition}` : '', 'unspecified', 'unspecified');
  };
  return {
    source: {
      subjects: structuredClone(input.subjects), scene: input.scene, sceneName: input.sceneName,
      sceneDescription: input.sceneDescription, sceneAtmosphere: [...(input.sceneAtmosphere ?? [])], styleDescription: input.styleDescription,
      speech: input.speech ? structuredClone(input.speech) : undefined, actions: [...input.actions],
      camera: { framing: input.framing, target: input.cameraCharacter, tightShot: input.tightShot, source: input.cameraSource ?? 'planner-default', preparedComposition: composition },
      startingState: structuredClone(shot.startingState), resultingState: structuredClone(shot.resultingState),
      recordedSceneState: input.recordedSceneState ? structuredClone(input.recordedSceneState) : undefined,
      commandEvidence: structuredClone(input.commandEvidence ?? []),
      referenceOwnership: [
        ...refs.images.map((r, i) => ({ label: `Image ${i + 1}`, name: r.name, role: r.role, assetId: r.assetId,
          sourceId: r.role === 'character' ? input.sceneContext?.characterImages.find(c => c.characterName === r.name)?.sourceId : r.role === 'set' ? input.sceneContext?.setImage.sourceId : undefined,
          description: r.role === 'character' ? input.subjects.find(c => c.name === r.name)?.description : r.role === 'set' ? input.sceneDescription : r.role === 'style' ? input.styleDescription : undefined })),
        ...refs.audios.map((r, i) => ({ label: `Audio ${i + 1}`, name: r.name, role: r.purpose, assetId: r.assetId, durationSeconds: r.durationSeconds })),
      ],
      continuity: { setupKey: shot.setupKey, continuityKey: shot.continuityKey, requiresPreviousFrame: shot.requiresPreviousFrame, hasMovement: shot.hasMovement },
      defaults: { cameraBehavior: 'fixed', soundscape: 'quiet room tone', source: 'formatter-default' },
    },
    durationSeconds: input.durationSeconds,
    framing: `${positive(input.framing)}${input.cameraCharacter && names.has(input.cameraCharacter) ? ` of ${input.cameraCharacter}` : ''}`,
    setting: positive(input.tightShot ? [input.sceneName, ...(input.sceneAtmosphere ?? [])].filter(Boolean).join(', ') : input.scene),
    style: positive(input.styleDescription), composition,
    references: refs.images.map((r, i) => ({ label: `Image ${i + 1}`, name: r.role === 'character' ? r.name : r.role, role: r.role })),
    audioReferences: refs.audios.map((r, i) => ({ label: `Audio ${i + 1}`, name: r.name, purpose: r.purpose })),
    visibleCast: visible.map(s => {
      const picture = refs.images.findIndex(r => r.role === 'character' && r.name === s.name);
      return {
        name: s.name, picture: picture >= 0 ? `Image ${picture + 1}` : undefined,
        appearance: positive(s.appearance) || (/^Body orientation:/i.test(s.description ?? '') ? '' : positive(s.description)),
        bodyOrientation: orientation(s.bodyOrientation ?? s.description?.replace(/^Body orientation:\s*/i, '')),
        posture: s.startingPosture === 'as authored' ? '' : positive(s.startingPosture),
        placement: composition ? `Starting placement and pose follow ${composition}` : input.tightShot ? '' : positive(s.startingBlocking),
        ending: [s.resultingPosture !== s.startingPosture && s.resultingPosture !== 'as authored' ? positive(s.resultingPosture) : '', s.resultingBlocking !== s.startingBlocking ? positive(s.resultingBlocking) : ''].filter(Boolean).join('. '),
        ...attention(s), emotion: positive(s.emotion),
      };
    }),
    actions: input.actions.map(positive).filter(Boolean),
    ...(input.speech ? { speech: {
      speaker: input.speech.speaker, visible: names.has(input.speech.speaker), dialogue: input.speech.dialogue,
      tone: positive(input.speech.tone),
      deliveryBeats: (input.speech.deliveryBeats ?? [{ phrase: input.speech.dialogue, directions: input.speech.deliveryDirections }]).map(b => ({ phrase: b.phrase, directions: b.directions.map(positive).filter(Boolean) })),
    } } : {}),
  };
}

