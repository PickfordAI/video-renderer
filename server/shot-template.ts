import type { ShotBrief } from './shot-brief.js';
import { projectShotBrief } from './shot-generation-brief.js';

const sentence = (text: string) => text.trim().replace(/[.\s]+$/, '');
const join = (parts: Array<string | undefined>) => [...new Set(parts.filter((s): s is string => Boolean(s)).map(sentence))].join('. ');

/** Both generation paths consume this same semantic projection of the complete brief. */
export function formatPositiveTemplate(input: ShotBrief): string {
  // Keep the tested balanced-template prose stable; directional enrichment is for the LLM input.
  const brief = projectShotBrief(input, { annotateHiddenDirections: false });
  const cast = brief.visibleCast;
  const speech = brief.speech;
  const hasStyle = brief.references.some(r => r.role === 'style');
  const roles = brief.references.filter(r => r.role !== 'character').map(r => {
    switch (r.role) {
      case 'composition': return `${r.label} establishes the selected camera view, starting composition, environment, lighting${hasStyle ? '' : ' and rendering style'}`;
      case 'camera-anchor': return `${r.label} establishes the camera setup and starting visual context`;
      case 'style': return `${r.label} supplies the rendering style`;
      case 'initial-frame': return `${r.label} supplies the starting visual context`;
      default: return `${r.label} supplies the set design and lighting${hasStyle ? '' : ' and rendering style'}`;
    }
  });
  const start = cast.map(s => {
    const placement = s.placement || (brief.composition ? `${s.name} begins in the placement shown in ${brief.composition}` : '');
    const posture = s.posture && !placement.toLowerCase().includes(s.posture.toLowerCase()) ? `${s.name} starts ${s.posture}` : '';
    return join([placement ? `Room-relative starting placement: ${placement}` : '', posture, s.bodyOrientation ? `${s.name}'s torso orientation: ${s.bodyOrientation}` : '']);
  });
  const gaze = cast.filter(s => s.eyeline).map(s => `${s.name} looks ${s.eyeline}${s.gaze.target === 'off-frame-character' ? ', using an off-axis conversational eyeline' : ''}`);
  // Addresses is deliberately separate: a speaker can look at a different person from their respondent.
  const address = speech?.respondent ? `${speech.speaker} addresses ${speech.respondent}` : '';
  const targetContext = [...new Set(brief.relationships.filter(r => r.target.includes('beyond the frame') && r.targetPlacement).map(r => `Room-relative attention context: ${r.targetPlacement}`))];
  const frame = brief.composition
    ? `${brief.camera.framing}${brief.camera.subject ? ` of ${brief.camera.subject}` : ''}, using the framing established by ${brief.composition}`
    : `${brief.camera.framing}${brief.camera.subject ? ` of ${brief.camera.subject}` : ''}`;
  const body = [
    roles.length ? `references: ${join(roles)}.` : '',
    `subject_definitions: ${join(cast.map(s => join([
      `${s.name}${s.picture ? `'s identity and wardrobe follow ${s.picture}` : ' is visible'}`,
      s.description ? `${s.name}: ${s.description}` : '', s.appearance ? `${s.name}: ${s.appearance}` : '',
    ])))}.`,
    brief.setting || brief.style ? `set: ${join([brief.setting, brief.style])}.` : '',
    `camera: The shot opens directly on the ${frame}. The camera holds this setup for one continuous ${brief.durationSeconds}-second take.`,
    start.some(Boolean) ? `starting_state: ${join(start)}.` : '',
    gaze.length || address ? `attention: ${join([...gaze, address, ...targetContext])}.` : '',
    `performance: ${join([
      ...cast.filter(s => s.emotion).map(s => `${s.name} appears ${s.emotion}`),
      ...brief.actions,
      ...(speech ? [`${speech.speaker}'s delivery is ${speech.tone || 'natural and conversational'}`,
        ...speech.deliveryBeats.filter(b => b.directions.length).map(b => `Delivery for ${JSON.stringify(b.phrase)} is ${b.directions.join(', then ')}`)] : []),
      ...cast.filter(s => speech && s.name !== speech.speaker).map(s => `${s.name} listens`),
      ...(!brief.continuity.hasMovement ? cast.map(s => `${s.name} stays in place throughout the shot`) : []),
      'Natural movement accompanies the performance within the authored blocking',
      ...(speech ? ['The scripted dialogue begins within the first half-second, at a natural conversational pace', 'After the line, the performer holds a brief natural reaction'] : []),
    ])}.`,
    speech ? `dialogue: ${speech.speaker}${speech.visible ? '' : ' (voice from beyond the frame)'} speaks this sentence once, verbatim: <d>[English] ${speech.dialogue}</d>` : '',
    brief.endingChanges.length ? `resulting_state: ${join(brief.endingChanges)}.` : '',
    ...brief.audioReferences.map(a => `audio_reference: ${a.label} supplies ${a.name}'s ${a.purpose === 'dialogue' ? 'exact spoken performance; match its words, timing, delivery and voice' : 'voice identity and timbre; the scripted dialogue supplies the words and timing'}.`),
    `overall_soundscape: ${speech ? `${speech.speaker}'s clear English speech over ` : ''}${brief.sound.description}.`,
  ];
  return body.filter(Boolean).join('\n');
}
