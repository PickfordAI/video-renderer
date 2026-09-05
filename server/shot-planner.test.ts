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
    expect(move.prompt).toContain('Perform the scripted actions; otherwise hold');
    expect(move.prompt).toContain('resulting_state: Maya is standing at platform');
    expect(move.hasMovement).toBe(true);
    const seated = planner.planGroup([command('sit', { character: 'Maya' }), talk()], 'sit', 'block').shots[0];
    expect(seated.continuityKey).not.toBe(move.continuityKey);
    const follow = planner.planGroup([talk()], 'follow', 'block').shots[0];
    expect(follow.continuityKey).toBe(seated.continuityKey);
    expect(follow.prompt).toContain('Maya is sitting at platform');
    expect(follow.prompt).toContain('Hold the established character positions');
    expect(follow.prompt).toContain('Hard cut into this camera setup');
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
    expect(first.prompt).toContain("Use Audio 1 only as Maya's voice identity and timbre reference");
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
    expect(shot.prompt).toContain('Continue from the supplied initial frame and preserve its camera framing');
    expect(shot.prompt).not.toContain('Hard cut');
  });

  it('moves inline TTS tags into acting directions while preserving only the spoken text and its duration', () => {
    const planner = new DssShotPlanner(configured);
    const shot = planner.planGroup([command('talk', {
      character: 'Maya', dialogue: '[whispering] Stay here. [firmly] I will return.', tone: 'concerned', audio_duration: 8.75,
    })], 'delivery', 'block').shots[0];
    expect(shot.dialogue).toBe('Stay here. I will return.');
    expect(shot.prompt).toContain('<d>[English] Stay here. I will return.</d>');
    expect(shot.prompt).toContain('Delivery directions, not spoken text, in order: whispering; firmly.');
    expect(shot.prompt).toContain('speaking in a concerned tone');
    expect(shot.audioDurationSeconds).toBe(8.75);
    expect(shot.durationSeconds).toBe(9);
    expect(shot.prompt).not.toContain('[whispering]');
    expect(() => planner.planGroup([talk('Maya', '[sighs]', 2)], 'nonverbal', 'block')).toThrow('no spoken words');
  });

  it('keeps delivery cues with their segment when long dialogue is split and omits exact whole-line audio', () => {
    const planner = new DssShotPlanner({ ...configured, useDialogueAudioReferences: true });
    const shots = planner.planGroup([command('talk', {
      character: 'Maya', dialogue: '[whispering] Stay by the station door. [firmly] I will come right back.',
      audio_duration: 20, audio: 'https://assets.example/long.wav',
    })], 'long-delivery', 'block').shots;
    expect(shots.map((shot) => shot.dialogue)).toEqual(['Stay by the station door.', 'I will come right back.']);
    expect(shots[0].prompt).toContain('in order: whispering.');
    expect(shots[0].prompt).not.toContain('firmly');
    expect(shots[1].prompt).toContain('in order: firmly.');
    expect(shots[1].prompt).not.toContain('whispering');
    expect(shots.every((shot) => shot.dialogueAudioUrl === undefined && shot.audioReferences[0].purpose === 'voice')).toBe(true);
  });

  it('keeps a tight shot on the intended speaker with a camera-relative eyeline and silent listeners', () => {
    const planner = new DssShotPlanner(configured);
    setup(planner);
    const tight = planner.planGroup([
      talk('lead'), command('look', { character: 'lead', target: { name: 'partner', bias: 'eyes' } }),
    ], 'tight', 'block').shots[0];
    expect(tight.prompt).toContain('close-up of Maya');
    expect(tight.prompt).toContain('Theo is off-screen; Maya addresses them with an eyeline just off-camera');
    expect(tight.prompt).toContain('Keep the camera on Maya');
    expect(tight.prompt).toContain('Only Maya speaks; any other characters listen silently');
    expect(tight.prompt).not.toContain('camera facing Theo');
    const wide = planner.planGroup([command('talk', { character: 'Maya', dialogue: 'Stay here.', camera_shot: 'Character_Full', respondent: 'Theo' })], 'wide', 'block').shots[0];
    expect(wide.prompt).toContain('Maya directs their eyeline toward Theo');
    expect(wide.prompt).not.toContain('Theo is off-screen');
    const reaction = planner.planGroup([
      command('character camera', { character: 'Theo', shot: 'Character_CloseUp' }),
      command('talk', { character: 'Maya', dialogue: 'Stay here.', respondent: 'Theo' }),
    ], 'reaction', 'block').shots[0];
    expect(reaction.prompt).toContain('camera holds on Theo listening silently');
    expect(reaction.prompt).not.toContain('Keep the camera on Maya');
  });

  it('uses only a neutral style or set anchor for global style, never a character portrait fallback', () => {
    const explicit = new DssShotPlanner(configured);
    setup(explicit);
    expect(explicit.planGroup([talk()], 'style', 'block').shots[0].prompt).toContain('Use Image 1 for the overall rendering style');
    const setOnly = new DssShotPlanner({ ...configured, styleImageUrl: undefined });
    setup(setOnly);
    expect(setOnly.planGroup([talk()], 'set-style', 'block').shots[0].prompt).toContain('Use Image 3 for the overall rendering style');
    const portraitsOnly = new DssShotPlanner({ characters: configured.characters });
    setup(portraitsOnly);
    const portraitShot = portraitsOnly.planGroup([talk()], 'portraits', 'block').shots[0];
    expect(portraitShot.prompt).toContain('Maya has the character design in Image 1');
    expect(portraitShot.prompt).not.toContain('for the overall rendering style');
    expect(portraitShot.prompt).not.toContain('art style of the supplied references');
  });

  it('does not treat a POV viewpoint as a close-up of the speaker', () => {
    const planner = new DssShotPlanner(configured);
    setup(planner);
    const pov = planner.planGroup([command('talk', {
      character: 'Maya', respondent: 'Theo', dialogue: 'Stay here.', camera_shot: 'Character_POV',
    })], 'pov', 'block').shots[0];
    expect(pov.prompt).toContain('point-of-view shot');
    expect(pov.prompt).toContain('Maya directs their eyeline toward Theo');
    expect(pov.prompt).not.toContain('Theo is off-screen');
    expect(pov.prompt).not.toContain('Keep the camera on Maya');
    expect(pov.prompt).not.toContain('Maya speaks from off-screen');
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
    expect(exact.prompt).toContain("Audio 1 contains Maya's exact spoken performance for this line; match its words, timing, delivery and voice");
    const sample = planner.planGroup([talk()], 'sample', 'block').shots[0];
    expect(sample.prompt).toContain("rather than copying the sample's words or timing");
    expect(sample.prompt).not.toContain('exact spoken performance');
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
