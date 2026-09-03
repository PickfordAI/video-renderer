import { describe, expect, it } from 'vitest';

import { buildStoryShots, createDssShotPlannerState, dssEventKey } from './dss';
import type { DssBrowserEvent, DssCommandGroup } from './types';

function event(commandGroups: DssCommandGroup[], sequence = 7, sceneIndex = 1): DssBrowserEvent {
  return {
    schema_version: 1,
    episode_id: 42,
    sequence,
    payload_id: `payload-${sequence}`,
    story_block_id: 'block-7',
    payload_hash: `hash-${sequence}`,
    ne_env: 'test',
    script: {
      story_block_id: 'block-7',
      scene_index: sceneIndex,
      story_block_index: 2,
      command_groups: commandGroups,
    },
  };
}

describe('buildStoryShots', () => {
  it('uses command groups as stable shot boundaries and carries production context', () => {
    const shots = buildStoryShots(
      event([
        {
          id: 'setup-group',
          commands: [
            { command: 'enable set', args: { set: 'Moonlit Diner', time_of_day: 'midnight' } },
            { command: 'add character', args: { name: 'Kent', character: 'kent' } },
          ],
        },
        {
          id: 'dialogue-group',
          commands: [
            {
              command: 'talk',
              args: {
                character: 'Kent',
                respondent: 'Autumn',
                dialogue: 'Someone moved the ledger after midnight.',
                tone: 'uneasy',
                camera_shot: 'Character_CloseUp',
                audio_duration: 3.2,
                audio: 'https://audio.example/kent-line.mp3',
              },
            },
          ],
        },
      ]),
      5,
      createDssShotPlannerState(),
    );

    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({
      storyBlockId: 'block-7:dialogue-group:talk-0-0',
      sourceGroupId: 'dialogue-group',
      source: 'live',
      durationSeconds: 5,
      characterNames: ['Kent', 'Autumn'],
      speakerName: 'Kent',
      dialogueAudioUrl: 'https://audio.example/kent-line.mp3',
    });
    expect(shots[0].prompt).toContain('Setting: Moonlit Diner');
    expect(shots[0].prompt).toContain('Characters present: Kent');
    expect(shots[0].prompt).toContain('Kent (uneasy) speaks to Autumn');
    expect(shots[0].prompt).toContain('Camera: Character CloseUp');
  });

  it('makes each dialogue turn its own shot even when turns share a group', () => {
    const shots = buildStoryShots(
      event([{ id: 'exchange', commands: [
        { command: 'talk', args: { character: 'Kent', dialogue: 'Did you see her leave?', audio_duration: 2 } },
        { command: 'talk', args: { character: 'Autumn', dialogue: 'Not after the lights went out.', audio_duration: 2.5 } },
      ] }]),
      5,
      createDssShotPlannerState(),
    );

    expect(shots.map((shot) => shot.title)).toEqual(['Kent', 'Autumn']);
    expect(shots.map((shot) => shot.storyBlockId)).toEqual([
      'block-7:exchange:talk-0-0',
      'block-7:exchange:talk-1-0',
    ]);
  });

  it('trusts authoritative audio duration when a complete line fits the clip', () => {
    const line = 'This complete sentence has more than nine written words but the recorded performance fits.';
    const shots = buildStoryShots(
      event([{ id: 'line', commands: [{ command: 'talk', args: { character: 'Kent', dialogue: line, audio_duration: 4.8 } }] }]),
      5,
      createDssShotPlannerState(),
    );

    expect(shots).toHaveLength(1);
    expect(shots[0].prompt).toContain(`“${line}”`);
    expect(shots[0].durationSeconds).toBe(7);
  });

  it('expands a clip instead of splitting a complete DSS dialogue turn', () => {
    const shots = buildStoryShots(
      event([{ id: 'long-line', commands: [{
        command: 'talk',
        args: {
          character: 'Autumn',
          dialogue: 'I found the letter. It was hidden beneath the ledger. I did not tell anyone.',
          audio_duration: 6.191,
        },
      }] }]),
      5,
      createDssShotPlannerState(),
    );

    expect(shots).toHaveLength(1);
    expect(shots[0].title).toBe('Autumn');
    expect(shots[0].durationSeconds).toBe(8);
    expect(shots[0].prompt).toContain('“I found the letter. It was hidden beneath the ledger. I did not tell anyone.”');
  });

  it('estimates a dynamic clip length when edge DSS omits audio_duration', () => {
    const dialogue = '[grounded reading from notes no lift] Victim is Jessica Vance. Twenty-six. [forensic neutral] Blunt force trauma back of the skull. [flat gesture to the floor] Found here in the lobby approximately an hour ago.';
    const shots = buildStoryShots(
      event([{ id: 'edge-line', commands: [{ command: 'talk', args: { character: 'Lily Song', dialogue } }] }]),
      5,
      createDssShotPlannerState(),
    );

    expect(shots).toHaveLength(1);
    expect(shots[0].durationSeconds).toBe(11);
    expect(shots[0].prompt).toContain(`“${dialogue}”`);
  });

  it('splits only when a dialogue performance cannot fit H3 Max\'s 15-second limit', () => {
    const shots = buildStoryShots(
      event([{ id: 'oversized-line', commands: [{
        command: 'talk',
        args: {
          character: 'Autumn',
          dialogue: 'I found the letter beneath the ledger after searching the office all night. Then I followed the courier across town without telling anyone. When I reached the station, the final train had already gone.',
          audio_duration: 28,
        },
      }] }]),
      5,
      createDssShotPlannerState(),
    );

    expect(shots.length).toBeGreaterThan(1);
    expect(shots.every((shot) => (shot.durationSeconds ?? 0) <= 15)).toBe(true);
    expect(shots.every((shot) => shot.speakerName === 'Autumn')).toBe(true);
    expect(shots.every((shot) => shot.dialogueAudioUrl === undefined)).toBe(true);
    expect(shots[0].title).toContain('Shot 1/');
  });

  it('preserves short dialogue audio and its authoritative duration for renderer padding', () => {
    const shots = buildStoryShots(
      event([{ id: 'short-line', commands: [{
        command: 'talk',
        args: {
          character: 'Marcus Kent',
          dialogue: 'Wait here.',
          audio: 'https://audio.example/marcus-short-line.mp3',
          audio_duration: 1.724082,
        },
      }] }]),
      5,
      createDssShotPlannerState(),
    );

    expect(shots).toHaveLength(1);
    expect(shots[0].prompt).toContain('Marcus Kent speaks: “Wait here.”');
    expect(shots[0].dialogueAudioUrl).toBe('https://audio.example/marcus-short-line.mp3');
    expect(shots[0].dialogueAudioDurationSeconds).toBe(1.724082);
  });

  it('carries set, cast, and emotion state across successive DSS payloads', () => {
    const state = createDssShotPlannerState();
    buildStoryShots(event([{ id: 'setup', commands: [
      { command: 'enable set', args: { set: 'Hotel Lobby' } },
      { command: 'add character', args: { name: 'Song' } },
      { command: 'set emotion', args: { character: 'Song', emotion: 'suspicious' } },
    ] }], 7), 5, state);
    const shots = buildStoryShots(event([{ id: 'next-line', commands: [
      { command: 'talk', args: { character: 'Song', dialogue: 'The bookend was moved.', audio_duration: 2 } },
    ] }], 8), 5, state);

    expect(shots[0].prompt).toContain('Setting: Hotel Lobby');
    expect(shots[0].prompt).toContain('Song (suspicious)');
  });

  it('uses the established scene cast as references for an opening action shot', () => {
    const state = createDssShotPlannerState();
    buildStoryShots(event([{ id: 'setup', commands: [
      { command: 'add character', args: { name: 'Marcus Kent' } },
      { command: 'add character', args: { name: 'Autumn Tate' } },
    ] }], 7), 5, state);

    const shots = buildStoryShots(event([{ id: 'opening', commands: [
      { command: 'still shot', args: { preset: 'Tense hotel lobby before dawn' } },
    ] }], 8), 5, state);

    expect(shots).toHaveLength(1);
    expect(shots[0].characterNames).toEqual(['Marcus Kent', 'Autumn Tate']);
    expect(shots[0].prompt).toContain('Characters present: Marcus Kent, Autumn Tate');
  });

  it('drops the previous cast when DSS advances to a new scene', () => {
    const state = createDssShotPlannerState();
    buildStoryShots(event([{ id: 'old-scene', commands: [
      { command: 'EnableSet', args: { set: 'Hotel Lobby' } },
      { command: 'SpawnCharacter', args: { name: 'Song' } },
    ] }], 7, 1), 5, state);
    const shots = buildStoryShots(event([{ id: 'new-scene', commands: [
      { command: 'CharacterTalk', args: { character: 'Kent', dialogue: 'We should search upstairs.', audio_duration: 2 } },
    ] }], 8, 2), 5, state);

    expect(shots[0].prompt).toContain('Setting: Hotel Lobby');
    expect(shots[0].prompt).not.toContain('Characters present: Song');
    expect(shots[0].prompt).toContain('Kent speaks');
  });

  it('does not manufacture shots for renderer metadata or audio-control groups', () => {
    const shots = buildStoryShots(event([{ id: 'metadata', commands: [
      { command: 'set fps', args: { fps: 24 } },
      { command: 'set channel volume', args: { channel: 'music', volume: 0.4 } },
    ] }]), 5, createDssShotPlannerState());
    expect(shots).toEqual([]);
  });

  it('does not regenerate a prerecorded cutscene as an H3 shot', () => {
    const shots = buildStoryShots(event([{ id: 'opening-cutscene', commands: [
      { command: 'enable set', args: { set: 'black room' } },
      {
        command: 'cutscene',
        args: {
          scene: 'video',
          scene_args: ['https://media.example/opening.webm'],
          duration_seconds: 35,
        },
      },
    ] }], 1, 1), 5, createDssShotPlannerState());

    expect(shots).toEqual([]);
  });

  it('treats repeated set and cast commands as context instead of paid shots', () => {
    const state = createDssShotPlannerState();
    const setup = [
      { id: 'set', commands: [{ command: 'enable set', args: { set: 'Interrogation Room' } }] },
      { id: 'cast', commands: [
        { command: 'show debug', args: { show: false } },
        { command: 'add character', args: { name: 'Marcus Kent' } },
        { command: 'add character', args: { name: 'June Morrison' } },
      ] },
    ];

    expect(buildStoryShots(event(setup, 7, 2), 5, state)).toEqual([]);
    const shots = buildStoryShots(event([
      ...setup,
      { id: 'line', commands: [{
        command: 'talk',
        args: {
          character: 'June Morrison',
          respondent: 'Marcus Kent',
          dialogue: "I don't know what to say.",
          audio_duration: 2.1,
        },
      }] },
    ], 8, 2), 5, state);

    expect(shots).toHaveLength(1);
    expect(shots[0].storyBlockId).toBe('block-7:line:talk-0-0');
    expect(shots[0].prompt).toContain('Setting: Interrogation Room');
    expect(shots[0].prompt).toContain('Characters present: Marcus Kent, June Morrison');
    expect(shots[0].prompt).toContain('June Morrison speaks to Marcus Kent');
  });

  it('suppresses exact dialogue repeats across a scene even after other DSS advances', () => {
    const state = createDssShotPlannerState();
    const line = (dialogue: string) => [{ id: dialogue, commands: [{
      command: 'talk',
      args: { character: 'June Morrison', dialogue, audio_duration: 2 },
    }] }];

    expect(buildStoryShots(event(line('I already told you.'), 7, 2), 5, state)).toHaveLength(1);
    expect(buildStoryShots(event(line('Then tell me where you went.'), 8, 2), 5, state)).toHaveLength(1);
    expect(buildStoryShots(event(line('I already told you.'), 9, 2), 5, state)).toEqual([]);
  });

  it('uses episode and sequence as the replacement key for replayed events', () => {
    expect(dssEventKey(event([], 11))).toBe('42:11');
  });
});
