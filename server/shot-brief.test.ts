import { readFileSync } from 'node:fs';
import { parseDssFrame } from './external-renderer.js';
import { MinimaxSceneAssetCache } from './scene-context.js';
import { describe, expect, it } from 'vitest';
import { DssShotPlanner } from './shot-planner.js';
import { buildShotBrief } from './shot-brief.js';

const command = (command: string, args: Record<string, unknown>) => ({ command, args });
const plannerFor = () => {
  const planner = new DssShotPlanner({
    characters: {
      Jimmy: { description: 'Jimmy wears a blue jacket.', imageUrl: 'https://assets.example/jimmy.png', voice: { url: 'https://assets.example/jimmy.wav', durationSeconds: 3 } },
      Denny: { imageUrl: 'https://assets.example/denny.png' },
      Jack: { imageUrl: 'https://assets.example/jack.png' },
    },
    sets: { Room: { description: 'A room with a red door.', imageUrl: 'https://assets.example/room.png' } },
    styleDescription: '2D animation', styleImageUrl: 'https://assets.example/style.png',
    markNames: { left: 'left side of the room', right: 'right side of the room' },
    useDialogueAudioReferences: true,
  });
  planner.planGroup([
    command('enable set', { set: 'Room', time_of_day: 'evening' }),
    command('add character', { name: 'Jimmy', point: { mark: 'left' }, appearance: 'Sleeves rolled up.' }),
    command('add character', { name: 'Denny', point: { mark: 'right' } }),
    command('add character', { name: 'Jack', point: { mark: 'left' } }),
    command('look', { character: 'Jimmy', target: { name: 'Denny', bias: 'eyes' } }),
  ], 'setup', 'block');
  return planner;
};
const talk = (extra = {}) => command('talk', { character: 'Jimmy', respondent: 'Jack', camera_shot: 'Character_CloseUp', dialogue: '[measured] This is not final, [earnest] but it works.', audio_duration: 5, ...extra });

describe('complete DSS shot brief', () => {
  it('hydrates recorded scene-state gaze IDs as persistent authored relationships before talk-only replay', async () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/prepared-coverage-dss.json', import.meta.url), 'utf8'));
    const frame = parseDssFrame(raw);
    const cache = new MinimaxSceneAssetCache({ fetchImpl: async url => new Response(`downloaded:${new URL(String(url)).pathname.split('/').at(-1)}`, { headers: { 'content-type': 'image/png' } }) });
    const context = await cache.resolve(frame.sceneContext!);
    const planner = new DssShotPlanner();
    planner.applySceneContext(context, 0);
    const theo = context.characterImages.find(c => c.characterName === 'Theo')!.sourceId;
    const maya = context.characterImages.find(c => c.characterName === 'Maya')!.sourceId;
    planner.applyRecordedSceneState({ version: 2, characters: { [theo]: { present: true, posture: 'standing relaxed', orientation: 'Torso toward Maya', gaze_character_id: maya } } });
    const brief = buildShotBrief(planner.planGroup([command('talk', { character: 'Theo', respondent: 'camera', camera_shot: 'Character_CloseUp', dialogue: 'Ready.', audio_duration: 5 })], 'recorded', 'block').shots[0]);
    expect(brief.source.subjects.find(s => s.name === 'Theo')).toMatchObject({ gaze: 'Maya', startingGaze: 'Maya', gazeSource: 'persistent-dss', bodyOrientation: 'Torso toward Maya', startingPosture: 'standing relaxed' });
    expect(brief.source.speech?.respondent).toBe('camera');
    expect(brief.source.commandEvidence.map(c => c.command)).toEqual(['talk']);
    expect(brief.source.recordedSceneState).toMatchObject({ characters: { [theo]: { gaze_character_id: maya } } });
  });

  it('retains recorded absence internally while excluding an absent cast member from a wide view and portrait references', () => {
    const planner = plannerFor();
    planner.applyRecordedSceneState({ version: 2, characters: { Denny: { present: false } } });
    const brief = buildShotBrief(planner.planGroup([talk({ camera_shot: 'wide shot' })], 'absent', 'block').shots[0]);
    expect(brief.source.subjects.find(s => s.name === 'Denny')).toMatchObject({ present: false, visible: false });
    expect(brief.visibleCast.map(s => s.name)).toEqual(['Jack', 'Jimmy']);
    expect(brief.source.referenceOwnership.filter(r => r.role === 'character').map(r => r.name)).toEqual(['Jack', 'Jimmy']);
    expect(brief.source.subjects.find(s => s.name === 'Jimmy')?.gaze).toBe('Denny (eye contact)');
  });

  it('preserves the persistent gaze relationship independently from the authored respondent and selected visibility', () => {
    const shot = plannerFor().planGroup([talk()], 'line', 'block').shots[0];
    const brief = buildShotBrief(shot);
    expect(brief.source.subjects.find(s => s.name === 'Jimmy')).toMatchObject({ gaze: 'Denny (eye contact)', gazeSource: 'persistent-dss', description: 'Jimmy wears a blue jacket.', appearance: 'Sleeves rolled up.', startingBlocking: 'Jimmy is standing at left side of the room' });
    expect(brief.source.subjects.find(s => s.name === 'Denny')).toMatchObject({ visible: false, resultingBlocking: 'Denny is standing at right side of the room' });
    expect(brief.source.speech).toMatchObject({ respondent: 'Jack', listener: 'Denny', dialogue: 'This is not final, but it works.' });
    expect(brief.source.camera).toMatchObject({ source: 'explicit-dss', target: 'Jimmy', tightShot: true });
    expect(brief.source.sceneDescription).toBe('A room with a red door.');
    expect(brief.source.styleDescription).toBe('2D animation');
    expect(brief.source.referenceOwnership.filter(r => r.role === 'character').map(r => r.name)).toEqual(['Jimmy']);
  });

  it('distinguishes an explicit camera look and emotion change from persistent state, preserving starting and ending evidence', () => {
    const shot = plannerFor().planGroup([
      command('sit', { character: 'Jimmy' }),
      command('look', { character: 'Jimmy', target: { name: 'camera' } }),
      command('set emotion', { character: 'Jimmy', emotion: 'amused' }),
      talk(),
    ], 'change', 'block').shots[0];
    const brief = buildShotBrief(shot);
    expect(brief.source.subjects.find(s => s.name === 'Jimmy')).toMatchObject({ startingPosture: 'standing', resultingPosture: 'sitting', startingGaze: 'Denny (eye contact)', gaze: 'camera', gazeSource: 'explicit-dss', emotion: 'amused', emotionSource: 'explicit-dss' });
    expect(brief.source.actions).toContain('Jimmy sits down.');
    expect(brief.source.startingState.characters.Jimmy.posture).toBe('standing');
    expect(brief.source.resultingState.characters.Jimmy.posture).toBe('sitting');
    expect(brief.source.speech?.respondent).toBe('Jack');
    expect(brief.visibleCast[0].eyeline).toBe('into the camera');
  });

  it('retains phrase delivery, audio ownership and ensemble relationships without copying audio payloads into semantic evidence', () => {
    const brief = buildShotBrief(plannerFor().planGroup([talk({ camera_shot: 'wide shot', audio: 'https://assets.example/exact.wav' })], 'wide', 'block').shots[0]);
    expect(brief.source.subjects.filter(s => s.visible).map(s => s.name)).toEqual(['Denny', 'Jack', 'Jimmy']);
    expect(brief.source.speech?.deliveryBeats).toEqual([{ phrase: 'This is not final,', directions: ['measured'] }, { phrase: 'but it works.', directions: ['earnest'] }]);
    expect(brief.source.referenceOwnership).toContainEqual(expect.objectContaining({ label: 'Audio 1', name: 'Jimmy', role: 'dialogue', durationSeconds: 5 }));
    expect(brief.source.commandEvidence[0].args).not.toHaveProperty('audio');
    expect(brief.source.commandEvidence[0].args).toMatchObject({ audio_duration: 5, respondent: 'Jack' });
    expect(brief.source.defaults.source).toBe('formatter-default');
  });
});
