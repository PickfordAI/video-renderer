import type { ShotPlannerState } from './shot-planner.js';

/** Stationary attention changes gaze only, never blocking or body orientation. */
export function preparedAttention(state: ShotPlannerState, visibleNames: readonly string[], speaker?: string, respondent?: string): string {
  const clauses: string[] = [];
  for (const name of visibleNames) {
    const authored = state.characters[name]?.gaze;
    const referenceEyeline = `${name} preserves the head angle and eye direction shown in Image 1 throughout the shot`;
    if (authored) {
      clauses.push(`${name} follows the authored look toward ${authored}.`);
    } else if (name === speaker) {
      if (respondent && respondent !== speaker && Object.hasOwn(state.characters, respondent)) {
        clauses.push(visibleNames.includes(respondent)
          ? `${referenceEyeline}, speaking to ${respondent} with their gaze on ${respondent}'s face.`
          : `${referenceEyeline}, looking toward ${respondent}'s established off-screen position while speaking; ${respondent} remains outside the shot.`);
      } else clauses.push(`${referenceEyeline} while speaking; no recipient is inferred.`);
    } else if (speaker) {
      clauses.push(`${referenceEyeline}, watching ${speaker} while listening silently.`);
    } else clauses.push(`${referenceEyeline}.`);
  }
  clauses.push('Keep body orientation and physical placement as composed, independently of gaze. Allow small natural head movements and blinks. Do not address the viewer or look into the camera unless an authored look explicitly requests it.');
  return clauses.join(' ');
}
