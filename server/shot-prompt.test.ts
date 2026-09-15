import { describe, expect, it } from 'vitest';
import { DssShotPlanner } from './shot-planner.js';
import { formatShotPrompt, selectShotPromptReferences, type ShotPromptInput } from './shot-prompt.js';

const input: ShotPromptInput = {
  subjects: [
    { name: 'Maya', visible: true, startingBlocking: 'Maya faces the door.', resultingBlocking: 'Maya faces the door.', gaze: 'Theo' },
    { name: 'Theo', visible: false },
  ],
  scene: 'Station', sceneName: 'Station', initialFrameOnly: false, framing: 'close-up', tightShot: true,
  cameraCharacter: 'Maya', durationSeconds: 6, actions: [],
};
const sections = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];
const command = (name: string, args: Record<string, unknown>) => ({ command: name, args });
const section = (prompt: string, name: string) => prompt.split(`${name}:\n`)[1].split(/\n\n[a-z_]+:\n/)[0];
const prose = (prompt: string) => prompt.replace(/<d>[\s\S]*?<\/d>/g, '');
const expectPositive = (prompt: string) => expect(prose(prompt)).not.toMatch(/\b(?:no|not|never|without|avoid|don['’]t|doesn['’]t|shouldn['’]t|rather than)\b/i);

describe('positive visible-shot prompt contract', () => {
  it('uses prepared composition and visible identity while keeping only positive per-subject attention', () => {
    const dialogue = '  Wait—here.\nStay  still.  ';
    const prompt = formatShotPrompt({ ...input,
      preparedAttention: 'Theo is off-screen. Do not turn toward Theo.',
      scene: 'Legacy room with three standing actors', styleDescription: 'Legacy style',
      subjects: [
        { name: 'Maya', visible: true, gaze: 'Theo', startingBlocking: 'Legacy camera-left position', bodyOrientation: 'Seated torso facing the doorway.' },
        { name: 'Theo', visible: false, bodyOrientation: 'Standing torso facing the window.' },
      ],
      speech: { speaker: 'Maya', listener: 'Theo', dialogue, deliveryDirections: ['whisper'] },
    }, [
      { name: 'Theo', role: 'character', label: 'Image 99', url: 'https://assets.example/theo.png' },
      { name: 'composition', role: 'composition', label: 'Image 99', url: 'https://assets.example/composition.png' },
      { name: 'Maya', role: 'character', label: 'Image 99', url: 'https://assets.example/maya.png' },
    ], [{ name: 'Maya', label: 'Audio 99', purpose: 'dialogue', durationSeconds: 3, url: 'https://assets.example/maya.wav' }]);
    expect(prompt.match(/^([a-z_]+):$/gm)?.map(value => value.slice(0, -1))).toEqual(sections);
    expect(prompt).toContain('<Picture 1> is the prepared composition anchor for [Shot 1].');
    expect(prompt).toContain('Character identity and appearance match <Picture 2>.');
    expect(prompt).toContain('Body orientation: Seated torso facing the doorway.');
    expect(prompt).toContain("Maya's eyeline follows the direction shown in <Picture 1>.");
    expect(prompt).toContain('Initial blocking: Character placement matches <Picture 1>.');
    expect(prompt).toContain('Ending state: Character placement and framing match <Picture 1>.');
    expect(section(prompt, 'retention_analysis')).toContain('character identity matches the original portraits');
    expect(prompt.match(/<d>\[English\] ([\s\S]*?)<\/d>/)?.[1]).toBe(dialogue);
    expect(prompt).not.toMatch(/Theo|Legacy|camera-left|off.screen|99/);
    expectPositive(prompt);
  });

  it.each(['voice', 'dialogue'] as const)('uses one scoped retention record per visible role and %s audio conditioning', purpose => {
    const prompt = formatShotPrompt({ ...input,
      actions: ['Maya walks to the platform.'],
      speech: { speaker: 'Maya', dialogue: 'Stay here.', deliveryDirections: [] },
    }, [
      { name: 'style', role: 'style', label: 'stale', url: 'https://assets.example/style.png' },
      { name: 'initial frame', role: 'initial-frame', label: 'stale', url: 'https://assets.example/opening.png' },
      { name: 'Maya', role: 'character', label: 'stale', url: 'https://assets.example/maya.png' },
      { name: 'set', role: 'set', label: 'stale', url: 'https://assets.example/set.png' },
      { name: 'camera anchor', role: 'camera-anchor', label: 'stale', url: 'https://assets.example/anchor.png' },
    ], [{ name: 'Maya', purpose, label: 'stale', durationSeconds: 3, url: 'https://assets.example/voice.wav' }]);
    const definitions = section(prompt, 'subject_definitions');
    const retention = section(prompt, 'retention_analysis');
    const labels = (text: string) => [...text.matchAll(/^<(?:Subject|Picture|Audio) \d+>/gm)].map(match => match[0]);
    expect(labels(retention)).toEqual(labels(definitions));
    expect(labels(retention)).toEqual(['<Subject 1>', '<Subject 2>', '<Picture 2>', '<Subject 3>', '<Picture 5>', '<Audio 1>']);
    for (const line of retention.split('\n')) expect(line).toMatch(/^<(?:Subject|Picture|Audio) \d+>(?: \([^\n]+\))?: (?:fully_preserved|reference) - .+$/);
    expect(definitions).toContain('for <Subject 1> (S1).');
    expect(prompt).toContain('[reference generation + keyframe completion + audio reference]');
    expect(prompt).toContain('Rendering style follows <Subject 2>.');
    expect(section(prompt, 'overall_soundscape')).not.toContain('<Audio 1>');
    expect(prompt).not.toMatch(/Theo|\(off.screen/);
    expectPositive(prompt);
  });

  it('keeps set style scope distinct from visual-context framing', () => {
    const prompt = formatShotPrompt(input, [
      { name: 'initial frame', role: 'initial-frame', label: 'stale', url: 'https://assets.example/context.png' },
      { name: 'set', role: 'set', label: 'stale', url: 'https://assets.example/set.png' },
    ], []);
    expect(prompt).toContain('<Subject 2> is the background set design and lighting and rendering style referenced from <Picture 2>');
    expect(prompt).toContain('summary:\n[reference generation]');
    expect(prompt).not.toContain('keyframe completion');
    expectPositive(prompt);
  });

  it('requires an actual composition reference for prepared coverage', () => {
    expect(() => formatShotPrompt({ ...input, preparedAttention: '' }, [], [])).toThrow('composition image reference');
  });

  it('preserves spoken negation, hidden names, Unicode and whitespace verbatim while filtering visual instructions', () => {
    const dialogue = '  “Don’t tell Theo!”\tÉcoute.\nLeave  it.  ';
    const prompt = formatShotPrompt({ ...input, speech: { speaker: 'Maya', dialogue, deliveryDirections: ['whisper', 'firmly'] } }, [], []);
    expect(prompt.match(/<d>\[English\] ([\s\S]*?)<\/d>/)?.[1]).toBe(dialogue);
    expect(prompt).toContain('<Subject 1> (S1), Maya speaks:');
    expect(prompt).toContain('Delivery: whisper; firmly.');
    expect(prose(prompt)).not.toContain('Theo');
    expect(prompt).toContain("Maya's eyeline is just beside the camera.");
    expectPositive(prompt);
  });

  it('removes hidden portrait and unrelated audio before numbering, without mutating inputs', () => {
    const testInput = { ...input, subjects: [{ name: 'set', visible: true }, { name: 'Maya', visible: false }], speech: { speaker: 'set', dialogue: 'Go.', deliveryDirections: [] } };
    const images = [
      { name: 'Maya', role: 'character' as const, label: 'Image 99', url: 'https://assets.example/maya.png' },
      { name: 'set', role: 'set' as const, label: 'Image 99', url: 'https://assets.example/set.png' },
      { name: 'set', role: 'character' as const, label: 'Image 99', url: 'https://assets.example/actor.png' },
    ];
    const audios = ['Maya', 'set'].map(name => ({ name, label: 'Audio 99', purpose: 'voice' as const, durationSeconds: 3, url: `https://assets.example/${name}.wav` }));
    const refs = selectShotPromptReferences(testInput, images, audios);
    expect(refs.images.map(ref => [ref.role, ref.label])).toEqual([['set', 'Image 1'], ['character', 'Image 2']]);
    expect(refs.audios.map(ref => [ref.name, ref.label])).toEqual([['set', 'Audio 1']]);
    expect(images.every(ref => ref.label === 'Image 99')).toBe(true);
    const prompt = formatShotPrompt(testInput, images, audios);
    expect(prompt).toContain('Character identity and appearance match <Picture 2>.');
    expect(prompt).not.toMatch(/Maya|99|<Picture 3>|<Audio 2>/);
    expectPositive(prompt);
  });

  it('uses positive initial-frame and ambience instructions with exact N/A for absent music', () => {
    const prompt = formatShotPrompt({ ...input, initialFrameOnly: true }, [
      { name: 'camera anchor', role: 'camera-anchor', label: 'Image 1', url: 'https://assets.example/frame.png' },
    ], []);
    expect(prompt).not.toMatch(/<(?:Picture|Audio) \d+>|<d>|Theo/);
    expect(prompt).toContain('Continue from the supplied initial frame');
    expect(prompt).toContain('Quiet environmental ambience.');
    expect(section(prompt, 'non_diegetic_music')).toBe('N/A');
    expectPositive(prompt);
  });

  it('keeps visible action order and scene-state transitions while holding camera framing', () => {
    const planner = new DssShotPlanner();
    planner.planGroup([command('add character', { name: 'Maya', point: { mark: 'door' } })], 'setup', 'block');
    const shot = planner.planGroup([command('character move to', { character: 'Maya', location: { name: 'platform' } }), command('sit', { character: 'Maya' })], 'move', 'block').shots[0];
    const details = section(shot.prompt, 'detailed_description');
    const beats = ['[Shot 1]', 'Initial blocking: Maya is standing at door', 'Maya walks to platform.', 'Maya sits down.', 'Ending state: Maya is sitting at platform'];
    const positions = beats.map(beat => details.indexOf(beat));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(shot.resultingState.characters.Maya.posture).toBe('sitting');
    expect(shot.prompt).not.toContain('<d>');
    expectPositive(shot.prompt);
  });

  it('admits visible positive clauses and leaves full-scene prose out of a close-up', () => {
    const prompt = formatShotPrompt({ ...input,
      scene: 'Coffee table behind three standing actors. Door outside this view.',
      subjects: [
        { name: 'Maya', visible: true, description: 'Green coat. Do not copy the background.', appearance: 'Silver earrings; without a hat', bodyOrientation: 'Torso facing forward, with a slight inward angle toward Theo.', startingBlocking: 'Maya sits camera-left beside the armchair. Theo stands beside her.', startingPosture: 'sitting', resultingBlocking: 'Maya remains seated.', resultingPosture: 'sitting', emotion: 'calm', gaze: 'Theo' },
        { name: 'Theo', visible: false, description: 'Red jacket', gaze: 'Maya', emotion: 'anxious' },
      ],
      actions: ['Theo walks toward Maya.', 'Maya raises her hand.', 'Do not move the camera.'],
    }, [], []);
    expect(prompt).toContain('Green coat. Silver earrings Body orientation: Torso facing forward');
    expect(prompt).toContain('Maya raises her hand.');
    expect(prompt).toContain('Initial blocking: Maya is sitting.');
    expect(prompt).toContain('The camera holds this framing throughout the shot.');
    expect(prompt).not.toMatch(/Theo|anxious|Red jacket|hat|Door|armchair|three standing actors/);
    expectPositive(prompt);
  });

  it('uses explicit eyeline direction and named visible targets without guessing a side from room marks', () => {
    const explicit = formatShotPrompt({ ...input, subjects: [{ name: 'Maya', visible: true, gazeDirection: 'slightly right of the lens', gaze: 'Theo' }, { name: 'Theo', visible: false }] }, [], []);
    expect(explicit).toContain("Maya's eyeline is slightly right of the lens.");
    expect(explicit).not.toContain('Theo');
    const visible = formatShotPrompt({ ...input, tightShot: false, subjects: [{ name: 'Maya', visible: true, gaze: 'Theo' }, { name: 'Theo', visible: true }] }, [], []);
    expect(visible).toContain('Maya looks toward Theo.');
  });

  it('keeps environmental look directions distinct from hidden-person eyelines', () => {
    const down = formatShotPrompt({ ...input, subjects: [{ name: 'Maya', visible: true, gaze: 'floor' }] }, [], []);
    expect(down).toContain('Maya looks downward.');
    expect(down).not.toContain('beside the camera');
    const unresolved = formatShotPrompt({ ...input, subjects: [{ name: 'Maya', visible: true, gaze: 'window' }] }, [], []);
    expect(unresolved).not.toMatch(/looks toward window|beside the camera/);
  });

  it('names an audible off-screen speaker without a visual Subject, portrait, or staging', () => {
    const planner = new DssShotPlanner({ characters: { Maya: { imageUrl: 'https://assets.example/maya.png', voice: { url: 'https://assets.example/maya.wav', durationSeconds: 3 } }, Theo: { imageUrl: 'https://assets.example/theo.png' } } });
    const shot = planner.planGroup([command('character camera', { character: 'Theo', shot: 'Character_CloseUp' }), command('talk', { character: 'Maya', dialogue: 'Stay here.' })], 'reaction', 'block').shots[0];
    expect(shot.imageReferences.map(image => image.name)).toEqual(['Theo']);
    expect(shot.referenceAudioUrls).toEqual(['https://assets.example/maya.wav']);
    expect(section(shot.prompt, 'subject_definitions')).toContain('<Subject 1> is Theo.');
    expect(section(shot.prompt, 'subject_definitions')).not.toMatch(/<Subject \d+> is Maya/);
    expect(section(shot.prompt, 'retention_analysis')).not.toContain('Maya');
    expect(shot.prompt).toContain('(S1), Maya (off screen) speaks: <d>[English] Stay here.</d>');
    expect(shot.prompt).toContain('Theo listens.');
    expectPositive(shot.prompt);
  });
});
