import { describe, expect, it } from 'vitest';
import { preparedAttention } from './prepared-attention.js';
import type { ShotPlannerState } from './shot-planner.js';

const state = { characters: {
  Ada: { name: 'Ada', posture: 'seated' },
  Bea: { name: 'Bea', posture: 'standing' },
  Cy: { name: 'Cy', posture: 'standing' },
} } as unknown as ShotPlannerState;

describe('prepared stationary attention', () => {
  it('uses a validated respondent and makes visible listeners watch the speaker', () => {
    const prompt = preparedAttention(state, ['Ada', 'Bea', 'Cy'], 'Ada', 'Bea');
    expect(prompt).toContain("Ada speaks to Bea, keeping their gaze on Bea's face");
    expect(prompt).toContain('Cy watches Ada');
    expect(prompt).toContain('body orientation and physical placement as composed, independently of gaze');
  });
  it('preserves eyeline for unknown, ambiguous, absent and self recipients', () => {
    for (const recipient of [undefined, 'Unknown', 'Bea or Cy', 'Ada', 'viewer']) {
      expect(preparedAttention(state, ['Ada'], 'Ada', recipient)).toContain('no recipient is inferred');
    }
  });
  it('does not bring an offscreen recipient into frame', () => {
    expect(preparedAttention(state, ['Ada'], 'Ada', 'Bea')).toContain('Bea remains outside the shot');
    expect(preparedAttention(state, ['Ada'], 'Ada', 'Bea')).not.toContain('Bea watches');
  });
  it('authored look overrides derived speaker and listener gaze', () => {
    const authored = structuredClone(state);
    authored.characters = { ...authored.characters, Ada: { ...authored.characters.Ada, gaze: 'window' }, Bea: { ...authored.characters.Bea, gaze: 'door' } };
    const prompt = preparedAttention(authored, ['Ada', 'Bea'], 'Ada', 'Bea');
    expect(prompt).toContain('Ada follows the authored look toward window');
    expect(prompt).toContain('Bea follows the authored look toward door');
    expect(prompt).not.toContain('Ada speaks to Bea');
    expect(prompt).not.toContain('Bea watches Ada');
  });
});
