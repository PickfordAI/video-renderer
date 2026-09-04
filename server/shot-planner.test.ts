import { describe, expect, it } from 'vitest';
import { DssShotPlanner, type ShotPlannerSettings } from './shot-planner.js';

const command = (name: string, args: Record<string, unknown> = {}) => ({ command: name, args });
const talk = (character = 'Maya', dialogue = 'We should go.', audio_duration = 3) => command('talk', { character, dialogue, audio_duration, camera_shot: 'Character_CloseUp' });
const configured: ShotPlannerSettings = {
  characters: {
    Maya: { aliases: ['lead'], description: 'A woman wearing a green coat.', imageUrl: 'https://assets.example/maya.png', voice: { url: 'https://assets.example/maya.wav', durationSeconds: 3 } },
    Theo: { aliases: ['partner'], imageUrl: 'https://assets.example/theo.png' },
  },
  sets: { Station: { imageUrl: 'https://assets.example/station.png', description: 'A tiled station with blue benches.' } },
  styleImageUrl: 'https://assets.example/style.png',
  markNames: { 'Station.Platform': 'platform', 'Station.Door': 'door' },
};
function setup(planner: DssShotPlanner) {
  return planner.planGroup([
    command('enable set', { set: 'Station', time_of_day: 'night' }),
    command('add character', { name: 'Maya', point: { mark: 'Station.Door' } }),
    command('add character', { name: 'Theo', point: { mark: 'Station.Platform' } }),
  ], 'setup', 'block');
}

describe('DSS shot planning', () => {
  it('treats setup, fades, titles and transport controls as state/timing without video jobs', () => {
    const planner = new DssShotPlanner(configured);
    expect(setup(planner).shots).toEqual([]);
    const result = planner.planGroup([
      command('show debug'), command('set fps', { fps: 30 }), command('cutscene', { scene: 'intro' }),
      command('show title', { title: 'Arrival', duration: 2 }), command('set channel volume', { volume: 1 }),
      { ...command('fade', { duration: 2 }), delay: 1 }, command('stop audio'),
    ], 'controls', 'block');
    expect(result.shots).toEqual([]);
    expect(result.delaySeconds).toBe(3);
    expect(result.resultingState.characters.Maya.mark).toBe('Station.Door');
  });

  it('restates persistent staging and gives later Look instructions to Talk in the same group', () => {
    const planner = new DssShotPlanner(configured);
    setup(planner);
    const shot = planner.planGroup([
      talk('LEAD'), command('look', { character: 'maya', target: { name: 'partner', bias: 'eyes' } }),
      command('set emotion', { character: 'Maya', emotion: 'concerned' }),
    ], 'dialogue', 'block').shots[0];
    expect(shot.speaker).toBe('Maya');
    expect(shot.prompt).toContain('Maya looks toward Theo (eye contact)');
    expect(shot.prompt).toContain('Maya appears concerned');
    expect(shot.prompt).toContain('Maya is standing at door');
    const next = planner.planGroup([talk()], 'next', 'block').shots[0];
    expect(next.prompt).toContain('Maya looks toward Theo (eye contact)');
    expect(next.prompt).toContain('night');
    expect(next.continuityKey).toBe(shot.continuityKey);
  });

  it('keeps movement starting state separate and invalidates setup anchors after staging changes', () => {
    const planner = new DssShotPlanner(configured);
    setup(planner);
    const before = planner.planGroup([talk()], 'before', 'block').shots[0];
    const move = planner.planGroup([
      command('character move to', { character: 'lead', location: { name: 'Station.Platform' } }), talk(),
    ], 'move', 'block').shots[0];
    expect(move.setupKey).toBe(before.setupKey);
    expect(move.continuityKey).not.toBe(before.continuityKey);
    expect(move.startingState.characters.Maya.mark).toBe('Station.Door');
    expect(move.resultingState.characters.Maya.mark).toBe('Station.Platform');
    expect(move.prompt).toContain('starting_state: Maya is standing at door');
    expect(move.prompt).toContain('Maya walks to platform');
    expect(move.prompt).toContain('resulting_state: Maya is standing at platform');
    expect(move.hasMovement).toBe(true);
    const seated = planner.planGroup([command('sit', { character: 'Maya' }), talk()], 'sit', 'block').shots[0];
    expect(seated.continuityKey).not.toBe(move.continuityKey);
    const follow = planner.planGroup([talk()], 'follow', 'block').shots[0];
    expect(follow.continuityKey).toBe(seated.continuityKey);
    expect(follow.prompt).toContain('Maya is sitting at platform');
  });

  it('invalidates anchors on cast, costume, set and lighting changes', () => {
    const planner = new DssShotPlanner(configured);
    setup(planner);
    const before = planner.planGroup([talk()], 'before', 'block').shots[0];
    const costume = planner.planGroup([command('add character', { name: 'Maya', costume: 'red coat' }), talk()], 'costume', 'block').shots[0];
    expect(costume.continuityKey).not.toBe(before.continuityKey);
    expect(costume.prompt).toContain('red coat');
    const cast = planner.planGroup([command('add character', { name: 'Ada' }), talk()], 'cast', 'block').shots[0];
    expect(cast.continuityKey).not.toBe(costume.continuityKey);
    const day = planner.planGroup([command('enable set', { set: 'Station', time_of_day: 'day' }), talk()], 'day', 'block').shots[0];
    expect(day.sceneKey).not.toBe(cast.sceneKey);
    expect(day.continuityKey).not.toBe(cast.continuityKey);
    expect(day.resultingState.characters.Theo).toBeUndefined();
  });

  it('uses restored staging before a shot instead of positions left over from the prior set', () => {
    const planner = new DssShotPlanner(configured);
    setup(planner);
    const shot = planner.planGroup([
      command('enable set', { set: 'Cafe' }),
      command('add character', { name: 'Maya', point: { mark: 'Cafe.Counter' } }),
      talk(),
    ], 'new-set', 'block').shots[0];
    expect(shot.startingState.characters.Maya.mark).toBe('Cafe.Counter');
    expect(shot.prompt).not.toContain('standing at door');
    expect(shot.prompt).toContain('standing at Counter');
  });

  it('uses stable canonical reference slots and the supplied art style without forcing live action', () => {
    const planner = new DssShotPlanner({ ...configured, aliases: { hero: 'protagonist', protagonist: 'lead' } });
    setup(planner);
    const first = planner.planGroup([talk('hero')], 'a', 'block').shots[0];
    const second = planner.planGroup([talk('partner')], 'b', 'block').shots[0];
    expect(first.speaker).toBe('Maya');
    expect(first.referenceImageUrls).toEqual(second.referenceImageUrls);
    expect(first.imageReferences.map((entry) => entry.label)).toEqual(['Image 1', 'Image 2', 'Image 3', 'Image 4']);
    expect(first.prompt).toContain('Maya has the character design in Image 2');
    expect(first.prompt).toContain('Theo has the character design in Image 3');
    expect(first.prompt).toContain('set design and lighting in Image 4');
    expect(first.prompt).toContain("Maya's voice follows Audio 1");
    expect(first.prompt).not.toMatch(/live.action|photorealistic/i);
    for (const match of first.prompt.matchAll(/Image (\d+)/g)) expect(first.referenceImageUrls[Number(match[1]) - 1]).toBeTruthy();
    for (const match of first.prompt.matchAll(/Audio (\d+)/g)) expect(first.referenceAudioUrls[Number(match[1]) - 1]).toBeTruthy();
  });

  it('compiles Turbo initial-frame prompts without unsupported reference arrays or phantom reference labels', () => {
    const planner = new DssShotPlanner({ ...configured, referenceMode: 'initial-frame', initialImageUrl: 'https://assets.example/frame.png', useDialogueAudioReferences: true });
    setup(planner);
    const shot = planner.planGroup([command('talk', { character: 'lead', dialogue: 'Stay here.', audio_duration: 5, audio: 'https://assets.example/line.wav' })], 'turbo', 'block').shots[0];
    expect(shot.referenceImageUrls).toEqual([]);
    expect(shot.referenceAudioUrls).toEqual([]);
    expect(shot.imageReferences).toEqual([]);
    expect(shot.audioReferences).toEqual([]);
    expect(shot.prompt).not.toMatch(/\b(?:Image|Audio) \d+\b/);
    expect(shot.prompt).toContain('A woman wearing a green coat.');
    expect(shot.prompt).toContain('Maya is standing at door');
    expect(shot.prompt).toContain('supplied initial frame provides the visual context');
    expect(shot.prompt).toContain('Preserve the visual medium and art style');
    expect(shot.prompt).toContain('<d>[English] Stay here.</d>');
    expect(shot.prompt).not.toContain("voice follows");
  });

  it('uses authoritative audio duration and never silently truncates long dialogue or repeats its audio', () => {
    const planner = new DssShotPlanner({ ...configured, useDialogueAudioReferences: true });
    setup(planner);
    const dialogue = 'Take the stairs to the platform. I will wait here until you return.';
    const result = planner.planGroup([command('talk', { character: 'Maya', dialogue, audio_duration: 15.882, audio: 'https://assets.example/whole-line.wav' })], 'long', 'block');
    expect(result.shots.length).toBeGreaterThan(1);
    expect(result.shots.map((shot) => shot.dialogue).join(' ')).toBe(dialogue);
    expect(result.shots.reduce((sum, shot) => sum + shot.audioDurationSeconds!, 0)).toBeCloseTo(15.882);
    for (const shot of result.shots) {
      expect(shot.durationSeconds).toBeGreaterThanOrEqual(5);
      expect(shot.durationSeconds).toBeLessThanOrEqual(15);
      expect(shot.sourceAudioDurationSeconds).toBe(15.882);
      expect(shot.dialogueAudioUrl).toBeUndefined();
      expect(shot.referenceAudioUrls).toEqual(['https://assets.example/maya.wav']);
      expect(shot.audioReferences[0].purpose).toBe('voice');
    }
    const short = planner.planGroup([talk('Maya', 'Yes.', 0.679)], 'short', 'block').shots[0];
    expect(short.durationSeconds).toBe(5);
    expect(short.audioDurationSeconds).toBe(0.679);
  });

  it('keeps exact audio only for a complete line and rejects unsafe reference budgets without truncating arrays', () => {
    const planner = new DssShotPlanner({ ...configured, useDialogueAudioReferences: true });
    setup(planner);
    const exact = planner.planGroup([command('talk', { character: 'Maya', dialogue: 'Stay here.', audio_duration: 8.75, audio: 'https://assets.example/line.wav' })], 'exact', 'block').shots[0];
    expect(exact.durationSeconds).toBe(9);
    expect(exact.dialogueAudioUrl).toBe('https://assets.example/line.wav');
    expect(exact.audioReferences[0]).toMatchObject({ purpose: 'dialogue', url: 'https://assets.example/line.wav', durationSeconds: 8.75 });
    const crowded = new DssShotPlanner({ characters: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`Person${i}`, { imageUrl: `https://assets.example/${i}.png` }])) });
    crowded.planGroup(Array.from({ length: 13 }, (_, i) => command('add character', { name: `Person${i}` })), 'cast', 'block');
    expect(() => crowded.planGroup([talk('Person0')], 'crowd', 'block')).toThrow('more than 12');
    const voices = new DssShotPlanner({ characters: { Maya: { voice: { url: 'https://assets.example/m.wav', durationSeconds: 8 } }, Theo: { voice: { url: 'https://assets.example/t.wav', durationSeconds: 8 } } } });
    setup(voices);
    expect(voices.planGroup([talk()], 'voices', 'block').shots[0].referenceAudioUrls).toEqual(['https://assets.example/m.wav']);
    expect(voices.planGroup([talk('Theo')], 'other-voice', 'block').shots[0].referenceAudioUrls).toEqual(['https://assets.example/t.wav']);
    expect(() => new DssShotPlanner({ characters: { Maya: { voice: { url: 'https://assets.example/m.wav', durationSeconds: 16 } } } })).toThrow('between 2 and 15');
  });

  it('freezes snapshots and leaves committed state intact when a group fails', () => {
    const planner = new DssShotPlanner(configured);
    const prepared = setup(planner);
    const before = planner.state;
    expect(() => planner.planGroup([command('sit', { character: 'Maya' }), command('teleport magically')], 'bad', 'block')).toThrow('Unsupported DSS command');
    expect(planner.state).toEqual(before);
    expect(() => { (prepared.resultingState.characters.Maya as { posture: string }).posture = 'floating'; }).toThrow();
    planner.planGroup([command('sit', { character: 'Maya' })], 'sit', 'block');
    expect(prepared.resultingState.characters.Maya.posture).toBe('standing');
    expect(planner.state.characters.Maya.posture).toBe('sitting');
    expect(() => planner.planGroup([command('look', { character: 'Maya', target: {} })], 'look', 'block')).toThrow('look target name');
  });

  it('rejects ambiguous aliases, unsafe URLs and unsplittable timing explicitly', () => {
    expect(() => new DssShotPlanner({ aliases: { first: 'second', second: 'first' } })).toThrow('Cyclic');
    expect(() => new DssShotPlanner({ characters: { Maya: { aliases: ['same'] }, Theo: { aliases: ['same'] } } })).toThrow('Ambiguous');
    expect(() => new DssShotPlanner({ styleImageUrl: 'file:///tmp/style.png' })).toThrow('HTTPS');
    expect(() => new DssShotPlanner({ initialImageUrl: 'https://user:password@assets.example/frame.png' })).toThrow('without credentials');
    expect(() => new DssShotPlanner().planGroup([talk('Maya', 'No.', 31)], 'long', 'block')).toThrow('word-level audio timing');
    expect(() => new DssShotPlanner().planGroup([command('talk', { character: 'Maya', dialogue: 'Hello.', audio_duration: 'bad' })], 'bad-duration', 'block')).toThrow('must be numeric');
  });
});
