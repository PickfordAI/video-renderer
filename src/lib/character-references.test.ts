import { describe, expect, it } from 'vitest';
import { createDefaultCharacterReferences, loadCharacterReferences, resolveCharacterReferences } from './character-references';
const cast = [
  { characterName: 'Alex', imageUrl: 'https://images.example/alex.png', audioUrl: 'https://audio.example/alex.mp3' },
  { characterName: 'Sam', imageUrl: 'https://images.example/sam.png', audioUrl: 'https://audio.example/sam.mp3' },
];
const beat = { storyBlockId: 'line', sceneIndex: 0, blockIndex: 0, sequence: 1, prompt: 'Alex speaks to Sam.', characterNames: ['Alex', 'Sam'], speakerName: 'Alex' };
describe('character references', () => {
  it('ships without proprietary media', () => expect(createDefaultCharacterReferences()).toEqual([]));
  it('matches user-provided images and sends only the speaker voice', () => {
    const result = resolveCharacterReferences(beat, cast);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ characterName: 'Alex', imageUrl: cast[0].imageUrl, audioUrl: cast[0].audioUrl, audioRole: 'voice_sample' });
    expect(result[1].audioUrl).toBeUndefined();
  });
  it('prefers exact DSS dialogue audio over the speaker sample', () => {
    const result = resolveCharacterReferences({ ...beat, dialogueAudioUrl: 'https://audio.example/line.mp3', dialogueAudioDurationSeconds: 1.724 }, cast);
    expect(result[0]).toMatchObject({ audioUrl: 'https://audio.example/line.mp3', audioRole: 'dialogue_performance', audioDurationSeconds: 1.724 });
    expect(result[1].audioUrl).toBeUndefined();
  });
  it('does not use voice samples when nobody speaks', () => {
    const result = resolveCharacterReferences({ ...beat, speakerName: undefined }, cast);
    expect(result).toHaveLength(2);
    expect(result.every(r => !r.audioUrl)).toBe(true);
  });
  it('migrates user-provided legacy image settings', () => {
    expect(loadCharacterReferences(undefined, 'Alex = https://images.example/alex.png')).toEqual([{ ...cast[0], audioUrl: '' }]);
  });
  it('does not match character names inside other words', () => {
    expect(resolveCharacterReferences({ ...beat, characterNames: undefined, prompt: 'Sample of a different story', speakerName: undefined }, cast)).toEqual([]);
  });
});
