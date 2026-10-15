import { describe, expect, it } from 'vitest';
import { relativeShotDirection } from './shot-directions.js';
import { DssShotPlanner } from './shot-planner.js';
import { buildShotBrief } from './shot-brief.js';
import { projectShotBrief } from './shot-generation-brief.js';

function shot(actor = 'Jack', gaze = 'Denny', body = 'Denny') {
  const planner = new DssShotPlanner({ characters: { Jack: {}, Denny: {}, Jimmy: {} },
    markNames: { r: 'Foreground rug right, clear of window furniture', c: 'Foreground rug center', l: 'Foreground rug left' } });
  planner.planGroup(['Jack', 'Denny', 'Jimmy'].map((name, i) => ({ command: 'add character', args: { name, point: { mark: ['r', 'c', 'l'][i] } } })), 'setup', 'block');
  planner.applyRecordedSceneState({ characters: { [actor]: { gaze: gaze, orientation: `Open front three-quarter torso, slight inward angle toward ${body}` } } });
  // Use the regular look command; recorded gaze hydration expects character IDs in real captures.
  return planner.planGroup([{ command: 'look', args: { character: actor, target: { name: gaze } } },
    { command: 'talk', args: { character: actor, respondent: body, dialogue: 'Ready.', camera_shot: 'Character_CloseUp', audio_duration: 5 } }], 'line', 'block').shots[0];
}

describe('direction-preserving anonymization', () => {
  it('gives Jack a leftward target delta from rug-right to rug-center, rather than treating his location as facing', () => {
    const brief = buildShotBrief(shot());
    const projected = projectShotBrief(brief);
    expect(projected.visibleCast[0].gaze.targetDirection).toMatchObject({ horizontal: 'left', coordinateSpace: 'room-relative',
      performerAnchor: 'Foreground rug right', targetAnchor: 'Foreground rug center' });
    expect(projected.visibleCast[0].eyeline).toContain("toward room-left from Jack's position");
    expect(projected.visibleCast[0].bodyOrientation).toContain("toward room-left from Jack's position");
    expect(projected.speech?.respondent).toContain('toward room-left');
    expect(JSON.stringify(projected)).not.toMatch(/Denny|Jimmy/);
    expect(brief.source.subjects.find(s => s.name === 'Jack')?.bodyOrientation).toContain('toward Denny');
  });

  it('resolves gaze and explicitly different torso/respondent targets independently', () => {
    const projected = projectShotBrief(buildShotBrief(shot('Denny', 'Jack', 'Jimmy')));
    expect(projected.visibleCast[0].eyeline).toContain('toward room-right');
    expect(projected.visibleCast[0].bodyOrientation).toContain('toward room-left');
    expect(projected.relationships.find(r => r.relation === 'looks-at')?.targetDirection?.horizontal).toBe('right');
    expect(projected.relationships.find(r => r.relation === 'addresses')?.targetDirection?.horizontal).toBe('left');
    expect(JSON.stringify(projected)).not.toMatch(/Jack|Jimmy/);
  });

  it('preserves explicit camera direction and declines unsupported lateral inferences', () => {
    const planned = structuredClone(shot());
    planned.promptInput.subjects.find(s => s.name === 'Jack')!.gazeDirection = 'toward camera-right';
    const projected = projectShotBrief(buildShotBrief(planned));
    expect(projected.visibleCast[0].eyeline).toBe('toward camera-right');
    expect(projected.visibleCast[0].gaze.directionSource).toBe('authored');
    expect(relativeShotDirection('Jack stands at rug right', 'Denny stands at window center')).toBeUndefined();
    expect(relativeShotDirection('Jack stands at rug center', 'Denny stands at rug center')).toBeUndefined();
    expect(relativeShotDirection('Jack stands at desk, clear of chair on right', 'Denny stands at rug left')).toBeUndefined();
  });
});
