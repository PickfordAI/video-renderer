import type { MinimaxSceneContext } from './scene-context.js';
import type { PlannedAudioReference, ShotImageReference } from './shot-planner.js';

/** Authored metadata only. Full scene state is retained here for visibility resolution. */
export interface ShotPromptInput {
  subjects: readonly {
    name: string;
    visible: boolean;
    description?: string;
    appearance?: string;
    startingBlocking?: string;
    startingPosture?: string;
    resultingBlocking?: string;
    resultingPosture?: string;
    bodyOrientation?: string;
    gaze?: string;
    /** An explicitly authored camera-relative direction, when available. */
    gazeDirection?: string;
    emotion?: string;
  }[];
  scene: string;
  /** Setting identity, separate from scene-wide staging prose. */
  sceneName?: string;
  /** Lighting/dressing metadata that remains applicable to the selected view. */
  sceneAtmosphere?: readonly string[];
  sceneContext?: MinimaxSceneContext;
  /** Presence selects prepared coverage. Attention is resolved per visible subject. */
  preparedAttention?: string;
  styleDescription?: string;
  initialFrameOnly: boolean;
  framing: string;
  cameraCharacter?: string;
  tightShot: boolean;
  durationSeconds: number;
  actions: readonly string[];
  speech?: {
    speaker: string;
    dialogue: string;
    deliveryDirections: readonly string[];
    tone?: string;
    listener?: string;
  };
}

/** Select once before numbering and submission; scene-state cast is not a reference roster. */
export function selectShotPromptReferences(input: ShotPromptInput, images: readonly ShotImageReference[], audios: readonly PlannedAudioReference[]): { images: ShotImageReference[]; audios: PlannedAudioReference[] } {
  if (input.initialFrameOnly) return { images: [], audios: [] };
  const visible = new Set(input.subjects.filter(subject => subject.visible).map(subject => subject.name));
  return {
    images: images.filter(image => image.role !== 'character' || visible.has(image.name))
      .map((image, index) => ({ ...image, label: `Image ${index + 1}` })),
    audios: audios.filter(audio => audio.name === input.speech?.speaker)
      .map((audio, index) => ({ ...audio, label: `Audio ${index + 1}` })),
  };
}

const named = (text: string, name: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
const negativeClause = /\b(?:no|not|never|without|avoid|exclude|excluding|instead|rather than|don['’]t|doesn['’]t|isn['’]t|aren['’]t|shouldn['’]t|mustn['’]t|can['’]t|won['’]t)\b|\boff[ -]?screen\b|\boutside (?:the |this )?(?:frame|view|shot)\b/i;
const additionalCast = /\b(?:two|three|four|five|six|multiple|several|other|additional)\s+(?:people|persons|men|women|characters|actors|figures)\b/i;

/** The caller supplies final ordered arrays. Only visible subjects become visual instructions. */
export function formatShotPrompt(input: ShotPromptInput, imageReferences: readonly ShotImageReference[], audioReferences: readonly PlannedAudioReference[]): string {
  const { speech, initialFrameOnly } = input;
  const subjects = input.subjects.filter(subject => subject.visible);
  const visibleNames = new Set(subjects.map(subject => subject.name));
  const hiddenNames = [...new Set([
    ...input.subjects.filter(subject => !subject.visible).map(subject => subject.name),
    ...[speech?.speaker, speech?.listener, input.cameraCharacter].filter((name): name is string => !!name && !visibleNames.has(name)),
  ])];
  // Admit complete positive clauses; dropping a negative word would reverse authored meaning.
  // Spoken dialogue bypasses this filter and remains verbatim.
  const visualText = (text?: string): string => (text ?? '').split(/(?<=[.!?])\s+|[;\n]+/)
    .filter(clause => clause.trim() && !negativeClause.test(clause)
      && !hiddenNames.some(name => named(clause, name))
      && !(input.tightShot && additionalCast.test(clause)))
    .map(clause => clause.trim()).join(' ');
  const orientationText = (text?: string): string => (text ?? '').split(/\s*,\s*|\s+with\s+/).map(visualText).filter(Boolean).join(', ');
  const selected = selectShotPromptReferences(input, imageReferences, audioReferences);
  const images = selected.images.map((image, index) => ({ ...image, label: `<Picture ${index + 1}>` }));
  const audios = selected.audios.map((audio, index) => ({ ...audio, label: `<Audio ${index + 1}>` }));
  const imageFor = (role: ShotImageReference['role']) => images.find(image => image.role === role)?.label;
  const prepared = input.preparedAttention !== undefined;
  const compositionImage = imageFor('composition');
  if (prepared && !compositionImage) throw new Error('Prepared shot prompt requires a composition image reference');
  const anchorImage = imageFor('camera-anchor');
  const subjectLabel = (name: string) => `<Subject ${subjects.findIndex(subject => subject.name === name) + 1}>`;
  const speakerInFrame = !!speech && visibleNames.has(speech.speaker);
  const frame = `${visualText(input.framing) || 'shot'}${input.cameraCharacter && visibleNames.has(input.cameraCharacter) ? ` of ${input.cameraCharacter}` : ''}`;
  const actions = input.actions.map(visualText).filter(Boolean);
  const style = prepared ? `Rendering style and lighting match ${compositionImage}.`
    : visualText(input.styleDescription) || (initialFrameOnly ? 'The visual medium and art style match the supplied initial frame.' : 'Coherent cinematic staging and expressive performances.');
  const retention: string[] = [];
  const definitions = subjects.map(subject => {
    const image = images.find(image => image.role === 'character' && image.name === subject.name)?.label;
    retention.push(`${subjectLabel(subject.name)} (appears in [Shot 1]): fully_preserved - Preserve ${subject.name}'s defined identity${image ? ` from ${image}` : ''}.`);
    return [
      `${subjectLabel(subject.name)} is ${subject.name}${speech?.speaker === subject.name ? ', speaker S1' : ''}.`,
      image ? `Character identity and appearance match ${image}.` : '',
      /^Body orientation:/i.test(subject.description ?? '') ? orientationText(subject.description) : visualText(subject.description), visualText(subject.appearance),
      orientationText(subject.bodyOrientation) ? `Body orientation: ${orientationText(subject.bodyOrientation)}` : '',
    ].filter(Boolean).join(' ');
  });
  const contentLabels = new Map<ShotImageReference['role'], string>();
  let contentSubjectNumber = subjects.length;
  for (const image of images) {
    if (image.role === 'character') continue;
    if (image.role === 'set' || image.role === 'style') {
      const label = `<Subject ${++contentSubjectNumber}>`;
      contentLabels.set(image.role, label);
      const role = image.role === 'set' ? `background set design and lighting${imageFor('style') ? '' : ' and rendering style'}` : 'overall rendering style';
      definitions.push(`${label} is the ${role} referenced from ${image.label}.`);
      retention.push(`${label} (appears in [Shot 1]): fully_preserved - Preserve the defined ${role} from ${image.label}.`);
    } else {
      const role = image.role === 'composition' ? 'prepared composition anchor'
        : image.role === 'camera-anchor' ? 'established camera composition anchor' : 'supplied visual-context anchor';
      definitions.push(`${image.label} is the ${role} for [Shot 1].`);
      retention.push(`${image.label} ([Shot 1] ${role}): fully_preserved - ${image.role === 'initial-frame'
        ? 'Preserve the supplied visual context.'
        : image.role === 'composition'
          ? 'Preserve the camera composition, character placement, environment, lighting and rendering style; character identity matches the original portraits.'
          : 'Preserve the established camera composition and character appearance.'}`);
    }
  }
  for (const audio of audios) {
    const speaker = speakerInFrame ? `${subjectLabel(audio.name)} (S1)` : `${audio.name} (S1), speaking off screen`;
    const role = audio.purpose === 'dialogue' ? 'spoken-performance reference' : 'voice identity and timbre reference';
    definitions.push(`${audio.label} is the ${role} for ${speaker}.`);
    retention.push(`${audio.label}: reference - ${audio.purpose === 'dialogue'
      ? 'Use the referenced words, timing, delivery and voice for the scripted line.'
      : 'Use the referenced voice identity and timbre for the scripted words.'}`);
  }
  const attention = subjects.map(subject => {
    const authoredDirection = visualText(subject.gazeDirection);
    if (authoredDirection) return `${subject.name}'s eyeline is ${authoredDirection}.`;
    const target = subject.gaze?.replace(/ \(eye contact\)$/, '')
      ?? (speech?.speaker === subject.name ? speech.listener : undefined);
    if (!target) return '';
    if (visibleNames.has(target)) return `${subject.name} looks toward ${target}.`;
    // A hidden target's room position is not a screen-space direction. Keep explicit
    // directional wording when present; otherwise retain the composition or use an unsided eyeline.
    const direction = /^(?:(?:toward|to) )?(?:camera[ -](?:left|right)|screen[ -](?:left|right)|(?:just |slightly )?(?:left|right) of (?:the )?(?:camera|lens)|(?:just )?(?:above|below) (?:the )?(?:camera|lens)|into (?:the )?(?:camera|lens))$/i.test(target) ? visualText(target) : '';
    if (direction) return `${subject.name}'s eyeline is ${direction}.`;
    if (/^(?:floor|ground)$/i.test(target)) return `${subject.name} looks downward.`;
    if (/^(?:ceiling|sky)$/i.test(target)) return `${subject.name} looks upward.`;
    if (prepared) return `${subject.name}'s eyeline follows the direction shown in ${compositionImage}.`;
    return hiddenNames.includes(target) ? `${subject.name}'s eyeline is just beside the camera.` : '';
  }).filter(Boolean);
  const blocking = (key: 'startingBlocking' | 'resultingBlocking') => subjects.map(subject => {
    if (!input.tightShot) return visualText(subject[key]);
    const posture = visualText(subject[key === 'startingBlocking' ? 'startingPosture' : 'resultingPosture']);
    return posture && posture !== 'as authored' ? `${subject.name} is ${posture}.` : '';
  }).filter(Boolean).join('; ');
  const delivery = speech?.deliveryDirections.map(visualText).filter(Boolean) ?? [];
  const performance = [
    ...actions,
    ...audios.map(audio => audio.purpose === 'dialogue'
      ? `${audio.label} supplies ${audio.name}'s spoken performance, timing, delivery and voice for this line.`
      : `${audio.name}'s voice identity and timbre match ${audio.label}.`),
    ...subjects.map(subject => visualText(subject.emotion) ? `${subject.name} appears ${visualText(subject.emotion)}.` : ''),
    delivery.length ? `Delivery: ${delivery.join('; ')}.` : '',
    speech ? `${speakerInFrame ? `${subjectLabel(speech.speaker)} (S1), ${speech.speaker}` : `(S1), ${speech.speaker} (off screen)`}${visualText(speech.tone) ? `, speaking in a ${visualText(speech.tone)} tone,` : ''} speaks: <d>[English] ${speech.dialogue}</d>` : '',
    ...subjects.filter(subject => speech && subject.name !== speech.speaker).map(subject => `${subject.name} listens.`),
  ].filter(Boolean);
  const taskTypes = [
    ...(images.some(image => ['character', 'set', 'style', 'initial-frame'].includes(image.role)) ? ['reference generation'] : []),
    ...(initialFrameOnly || compositionImage || anchorImage ? ['keyframe completion'] : []),
    ...(audios.length ? ['audio reference'] : []),
  ];
  // Full-scene prose can request people and landmarks outside a close-up. Setting
  // identity and the set reference ground that view without importing the full layout.
  const setting = visualText(input.tightShot
    ? [input.sceneName, ...(input.sceneAtmosphere ?? [])].filter(Boolean).join(', ')
    : input.scene);
  const globalStyle = contentLabels.get('style') ?? contentLabels.get('set');
  return [
    `subject_definitions:\n${definitions.join('\n') || 'N/A'}`,
    `summary:\n${taskTypes.length ? `[${taskTypes.join(' + ')}] ` : ''}A single ${input.durationSeconds}-second ${frame}.${setting ? ` Setting: ${setting}.` : ''} ${speech ? `${speech.speaker} delivers one scripted line${speakerInFrame ? '' : ' off screen'}.` : 'The shot presents the authored action.'}`,
    `retention_analysis:\n${retention.join('\n') || 'N/A'}`,
    `detailed_description:\n${[
      style, globalStyle ? `Rendering style follows ${globalStyle}.` : '',
      `[Shot 1] ${initialFrameOnly ? `Continue from the supplied initial frame with a ${frame}.` : `Open directly on a ${frame}.`} The camera holds this framing throughout the shot.`,
      prepared ? `Camera composition, character placement and background match ${compositionImage}.`
        : anchorImage ? `Camera composition and character appearance match ${anchorImage}.` : '',
      prepared ? `Initial blocking: Character placement matches ${compositionImage}.`
        : blocking('startingBlocking') ? `Initial blocking: ${blocking('startingBlocking')}` : '',
      ...attention,
      ...performance,
      prepared ? `Ending state: Character placement and framing match ${compositionImage}.`
        : blocking('resultingBlocking') ? `Ending state: ${blocking('resultingBlocking')}` : '',
    ].filter(Boolean).join('\n')}`,
    `overall_soundscape:\n${speech ? 'Natural dialogue acoustics and quiet room tone.' : 'Quiet environmental ambience.'}`,
    'non_diegetic_music:\nN/A',
  ].join('\n\n');
}
