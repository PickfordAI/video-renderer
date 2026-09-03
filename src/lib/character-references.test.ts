import { describe, expect, it } from 'vitest';

import {
  createDefaultCharacterReferences,
  loadCharacterReferences,
  resolveCharacterReferences,
} from './character-references';

describe('character references', () => {
  it('maps DSS aliases to canonical Whispers assets in shot order', () => {
    const references = resolveCharacterReferences({
      storyBlockId: 'line',
      sceneIndex: 0,
      blockIndex: 0,
      sequence: 1,
      prompt: 'Kent speaks to Autumn.',
      characterNames: ['Kent', 'Autumn'],
      speakerName: 'Kent',
    }, createDefaultCharacterReferences());

    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({
      characterName: 'Marcus Kent',
      assetKey: 'whispers/kent.jpg',
      audioUrl: expect.stringContaining('/kent-'),
    });
    expect(references[1]).toMatchObject({
      characterName: 'Autumn Tate',
      assetKey: 'whispers/autumn.jpg',
    });
    expect(references[1].audioUrl).toBeUndefined();
  });

  it('uses editable image and audio overrides for an exact character', () => {
    const references = resolveCharacterReferences({
      storyBlockId: 'line',
      sceneIndex: 0,
      blockIndex: 0,
      sequence: 1,
      prompt: 'Marcus Kent studies the ledger.',
      characterNames: ['Marcus Kent'],
      speakerName: 'Marcus Kent',
    }, [{
      characterName: 'Marcus Kent',
      imageUrl: 'https://images.example/kent.png',
      audioUrl: 'https://audio.example/kent.mp3',
    }]);

    expect(references).toEqual([{
      characterName: 'Marcus Kent',
      imageUrl: 'https://images.example/kent.png',
      audioUrl: 'https://audio.example/kent.mp3',
      audioRole: 'voice_sample',
    }]);
  });

  it('prefers exact DSS line audio and never gives the respondent a voice reference', () => {
    const references = resolveCharacterReferences({
      storyBlockId: 'line',
      sceneIndex: 0,
      blockIndex: 0,
      sequence: 1,
      prompt: 'June speaks to Marcus.',
      characterNames: ['June Morrison', 'Marcus Kent'],
      speakerName: 'June Morrison',
      dialogueAudioUrl: 'https://audio.example/june-exact-line.mp3',
      dialogueAudioDurationSeconds: 1.724082,
    }, createDefaultCharacterReferences());

    expect(references[0]).toMatchObject({
      characterName: 'June Morrison',
      audioUrl: 'https://audio.example/june-exact-line.mp3',
      audioRole: 'dialogue_performance',
      audioDurationSeconds: 1.724082,
    });
    expect(references[1]).toMatchObject({ characterName: 'Marcus Kent' });
    expect(references[1].audioUrl).toBeUndefined();
  });

  it('does not send voice audio when no character is speaking', () => {
    const references = resolveCharacterReferences({
      storyBlockId: 'action',
      sceneIndex: 0,
      blockIndex: 0,
      sequence: 1,
      prompt: 'Kent and Autumn enter the lobby.',
      characterNames: ['Kent', 'Autumn'],
    }, createDefaultCharacterReferences());

    expect(references).toHaveLength(2);
    expect(references.every((reference) => reference.audioUrl === undefined)).toBe(true);
  });

  it('migrates the old image-only override format without losing voice defaults', () => {
    const references = loadCharacterReferences(undefined, [
      'Marcus Kent = https://images.example/kent.png',
      'Nora Vale = https://images.example/nora.jpg',
    ].join('\n'));

    expect(references.find((reference) => reference.characterName === 'Marcus Kent')).toMatchObject({
      imageUrl: 'https://images.example/kent.png',
      audioUrl: expect.stringContaining('/kent-'),
    });
    expect(references.at(-1)).toEqual({
      characterName: 'Nora Vale',
      imageUrl: 'https://images.example/nora.jpg',
      audioUrl: '',
    });
  });

  it('maps old placeholder surnames to the canonical Whispers roster', () => {
    const references = resolveCharacterReferences({
      storyBlockId: 'line',
      sceneIndex: 0,
      blockIndex: 0,
      sequence: 1,
      prompt: 'Richard Vance answers Cassandra Wells.',
      characterNames: ['Richard Vance', 'Cassandra Wells'],
    }, createDefaultCharacterReferences());

    expect(references.map((reference) => reference.characterName)).toEqual(['Richard Cho', 'Cassandra Vexon']);
  });
});
