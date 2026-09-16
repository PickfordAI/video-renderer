import { describe, expect, it } from 'vitest';
import { DssShotPlanner } from './shot-planner.js';
import { buildShotBrief } from './shot-brief.js';
import { projectShotBrief } from './shot-generation-brief.js';
import { formatPositiveTemplate } from './shot-template.js';

function compile(camera = 'Character_CloseUp', gaze = 'Maya') {
  const planner = new DssShotPlanner({
    characters: { Theo: { description: 'Tall, wearing a green shirt. Body turned toward Maya.', imageUrl: 'https://example.com/theo.png', voice: { url: 'https://example.com/voice.mp3', durationSeconds: 3 } }, Maya: {}, Rose: {} },
    sets: { Study: { description: 'A desk beside the window.', imageUrl: 'https://example.com/study.png' } },
    styleDescription: 'Hand-drawn animation.', styleImageUrl: 'https://example.com/style.png',
  });
  planner.planGroup([
    { command: 'enableSet', args: { set: 'Study', time_of_day: 'evening' } },
    { command: 'addCharacter', args: { character: 'Theo', posture: 'standing', point: { mark: 'window' }, appearance: 'Rolled-up sleeves' } },
    { command: 'addCharacter', args: { character: 'Maya', point: { mark: 'desk' } } },
    { command: 'addCharacter', args: { character: 'Rose', point: { mark: 'door' } } },
  ], 'setup', 'block');
  return planner.planGroup([
    { command: 'look', args: { character: 'Theo', target: { name: gaze } } },
    { command: 'setEmotion', args: { character: 'Theo', emotion: 'concerned' } },
    { command: 'playAnimation', args: { character: 'Theo', animation: 'finger point' } },
    { command: 'talk', args: { character: 'Theo', respondent: 'Rose', camera_shot: camera, dialogue: '[measured] This is not final, [earnest] but it is useful.', tone: 'thoughtful', audio_duration: 5 } },
  ], 'line', 'block').shots[0];
}

describe('brief to template boundary', () => {
  it('retains authored descriptions, placement, actions, mood, recipient and voice role in a tight shot', () => {
    const brief = buildShotBrief(compile());
    const out = formatPositiveTemplate(brief);
    expect(out).toContain('dialogue begins within the first half-second, at a natural conversational pace');
    expect(out).not.toContain('performance spans');
    for (const value of ['green shirt', 'Rolled-up sleeves', 'standing at window', 'desk beside the window', 'Hand-drawn animation', 'concerned', 'finger point', 'thoughtful', 'measured', 'earnest', 'voice identity and timbre']) expect(out).toContain(value);
    expect(out).not.toMatch(/\b(?:Maya|Rose)\b/);
    expect(out).toContain('Body turned toward the person beyond the frame');
    expect(out).toContain('Theo addresses the other person beyond the frame');
    expect(out).toContain('the person beyond the frame is standing at desk');
    expect(out).toContain('the other person beyond the frame is standing at door');
    expect(out).toContain('Image 1 supplies the rendering style');
    expect(out).toContain('Image 3 supplies the set design and lighting');
    expect(out).toContain('<d>[English] This is not final, but it is useful.</d>');
    expect(projectShotBrief(brief).relationships.map(r => r.relation)).toEqual(['looks-at', 'addresses']);
  });
  it('keeps visible relationships named in an ensemble and an authored camera look distinct from respondent', () => {
    const wide = formatPositiveTemplate(buildShotBrief(compile('Character_Medium')));
    expect(wide).toContain('Theo looks toward Maya');
    expect(wide).toContain('Theo addresses Rose');
    expect(wide).toContain('Maya listens');
    const direct = formatPositiveTemplate(buildShotBrief(compile('Character_CloseUp', 'camera')));
    expect(direct).toContain('Theo looks into the camera');
    expect(direct).toContain('Theo addresses the other person beyond the frame');
  });
  it('retains an authored direction even with a named gaze target, and respects a directional respondent', () => {
    const planned = structuredClone(compile());
    planned.promptInput.subjects.find(s => s.name === 'Theo')!.gazeDirection = 'toward camera-left';
    planned.promptInput.speech!.respondent = 'camera';
    const projected = projectShotBrief(buildShotBrief(planned));
    expect(projected.visibleCast[0].eyeline).toBe('toward camera-left');
    expect(projected.speech?.respondent).toBe('camera');
  });
  it('keeps raw constraints while expressing known source wording affirmatively', () => {
    const planned = structuredClone(compile());
    planned.promptInput.subjects.find(s => s.name === 'Theo')!.description = 'Theo stands without his coat, facing Maya.';
    planned.promptInput.sceneDescription = 'A desk beside the window. Door outside this view.';
    const brief = buildShotBrief(planned);
    expect(brief.source.subjects.find(s => s.name === 'Theo')!.description).toContain('without his coat');
    const template = formatPositiveTemplate(brief);
    expect(template).toContain('Theo stands coatless, facing the person beyond the frame');
    expect(template).toContain('A desk beside the window');
    expect(template).not.toContain('outside this view');
  });
  it('keeps off-frame speech as voice attribution without adding its portrait to the reaction shot', () => {
    const planned = structuredClone(compile());
    planned.promptInput.subjects.forEach(s => { s.visible = s.name === 'Maya'; });
    planned.promptInput.cameraCharacter = 'Maya';
    const out = formatPositiveTemplate(buildShotBrief(planned));
    expect(out).toContain('Theo (voice from beyond the frame) speaks');
    expect(out).toContain('Maya listens');
    expect(out).not.toContain("Theo's identity and wardrobe");
  });
});
