import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ANIMATION_PHRASES, BIBLE, deliveryCue, parseDeliverySegments, resolveLocation } from './compile.js';
import { loadDssRecording } from '../dss-replay.js';
import { packWhispmaxClips, splitDialogue, type WhispmaxSourcePayload } from './pack.js';

const STYLE = 'WhispMax style - Stylized 3D game-engine animation with matte toon shading: smooth simplified faces, large expressive eyes, painterly hair with visible strand highlights, soft flat ambient lighting, muted desaturated palette and subtle soft shadows; not photorealistic, no film grain, no glossy skin.';
const MARCUS = 'Marcus Kent - Marcus Kent, a young adult detective with medium-length dark brown wavy hair swept back and messy, thick dark eyebrows, dark eyes, a defined jawline and light stubble, slender build. He wears a dark green suit jacket over a white button-up shirt with a dark red tie hanging loose and crooked at the collar.';
const JUNE = 'June Morrison - June Morrison, an adult woman with red hair pulled back into a short bun, wearing round thin-rimmed glasses and a dark green v-neck long-sleeved top; slender build.';
const WAITING_ROOM = 'interrogation room — waiting room - The waiting area of the police station: dark teal-green walls, a dark doorway opening to a brighter hallway, and the edge of a red-and-white striped flag on the wall; dim greenish overhead light.';
const INTERROGATION_ROOM = 'interrogation room - The interrogation room itself: bare dark teal-green walls with horizontal paneling and faint scuffs, no furniture in frame, a single hard light isolating the speaker in the dim room.';

function payload(sequence: number, groups: Array<Array<Record<string, unknown>>>): WhispmaxSourcePayload {
  return {
    sequence,
    storyBlockId: 'block-1',
    groups: groups.map((commands, index) => ({ id: `g${sequence}-${index}`, commands })),
  };
}
const enableSet = (set: string) => ({ command: 'enable set', args: { set } });
const addCharacter = (name: string, zone: string) => ({ command: 'add character', args: { name, point: { zone, mark: 'post.1' } } });
const look = (character: string, name: string) => ({ command: 'look', args: { character, target: { type: 'Character', name } } });
const emotion = (character: string, value: string) => ({ command: 'set emotion', args: { character, emotion: value } });
const animate = (character: string, animation: string) => ({ command: 'play animation', args: { character, animation } });

describe('WhispMax bible', () => {
  it('carries the appendix: 7 characters, 4 whole sets, and zones keyed by set plus JSON zone value', () => {
    expect(Object.keys(BIBLE.characters)).toHaveLength(7);
    expect(Object.keys(BIBLE.sets)).toEqual(['black room', 'interrogation room', 'hotel lobby', 'coroner']);
    // hallway.1 and hallway.2 are distinct entries that share the display label; room.suite is the suite.
    expect(BIBLE.zones['interrogation room|hallway.1'].description).not.toBe(BIBLE.zones['interrogation room|hallway.2'].description);
    expect(BIBLE.zones['interrogation room|hallway.1'].label).toBe('hallway');
    expect(BIBLE.zones['hotel lobby|room.suite'].label).toBe('suite');
    expect(BIBLE.trigger).toBe('WhispMax');
  });

  it('renders the zone-level line, the set-is-zone line, and the unknown-zone fallback', () => {
    expect(resolveLocation('interrogation room', 'waiting room').line).toBe(WAITING_ROOM);
    expect(resolveLocation('interrogation room', 'interrogation room').line).toBe(INTERROGATION_ROOM);
    const unknown = resolveLocation('interrogation room', 'boiler room');
    expect(unknown.line).toBe(`interrogation room - ${BIBLE.sets['interrogation room']}`);
    expect(unknown.warnings.join()).toContain('Zone outside the WhispMax bible');
    // `banish` is DSS staging, not a place: it falls back silently.
    expect(resolveLocation('hotel lobby', 'banish').warnings).toEqual([]);
    expect(resolveLocation('spaceship', 'bridge').warnings.join()).toContain('Set outside the WhispMax bible');
  });
});

describe('delivery cues', () => {
  it('splits bracketed cues, collapses consecutive duplicates, and keeps the text verbatim', () => {
    expect(parseDeliverySegments('[uneasy] I don’t know what to say.')).toEqual([
      { cue: 'uneasy', text: 'I don’t know what to say.' },
    ]);
    expect(parseDeliverySegments('[firm] One. [firm] Two. [tense] Three.')).toEqual([
      { cue: 'firm', text: 'One. Two.' },
      { cue: 'tense', text: 'Three.' },
    ]);
    expect(parseDeliverySegments('No cue at all.')).toEqual([{ text: 'No cue at all.' }]);
    expect(parseDeliverySegments('No cue at all.', 'wry')).toEqual([{ cue: 'wry', text: 'No cue at all.' }]);
  });
});

describe('animation table', () => {
  it('uses the trained wordings and omits the default label', () => {
    expect(ANIMATION_PHRASES['embarassed talking']).toBe('speaks with embarrassment');
    expect(ANIMATION_PHRASES['finger point']).toBe('points a finger');
    expect(ANIMATION_PHRASES.talking).toBe('');
    expect(ANIMATION_PHRASES.exasperated).toBeUndefined();
  });

  it('drops unlisted animation labels rather than inventing a phrase', () => {
    const plan = packWhispmaxClips([payload(1, [
      [enableSet('interrogation room'), addCharacter('Marcus Kent', 'interrogation room')],
      [
        { command: 'talk', args: { character: 'Marcus Kent', dialogue: '[firm] Enough.', camera_shot: 'Character_CloseUp', camera_update: true, audio_duration: 4.7 } },
        animate('Marcus Kent', 'exasperated'),
        animate('Marcus Kent', 'talking'),
      ],
    ])]);
    expect(plan.clips[0].prompt).toContain('Marcus Kent says with firm delivery, “Enough.”');
    expect(plan.clips[0].prompt).not.toContain('exasperated');
    expect(plan.clips[0].prompt).not.toContain('talking');
  });
});

describe('golden prompts from the prompting guide', () => {
  it('reproduces the two-shot June/Marcus 6-second waiting-room caption byte for byte', () => {
    const plan = packWhispmaxClips([payload(1, [
      [enableSet('interrogation room')],
      [addCharacter('June Morrison', 'waiting room'), addCharacter('Marcus Kent', 'waiting room')],
      [
        {
          command: 'talk',
          args: {
            character: 'June Morrison', respondent: 'Marcus Kent',
            dialogue: '[uneasy] I don\'t know what to say.', tone: 'uneasy',
            camera_shot: 'Character_CloseUp', camera_update: true, audio_duration: 2.283,
          },
        },
        look('June Morrison', 'Marcus Kent'),
        emotion('June Morrison', 'uneasy'),
        animate('June Morrison', 'embarassed talking'),
      ],
      [
        {
          command: 'talk',
          args: {
            character: 'Marcus Kent', respondent: 'June Morrison',
            dialogue: '[earnest] Say that you love me. [hopeful] That you understand.',
            camera_shot: 'Character_CloseUp', camera_update: true, audio_duration: 3.1,
          },
        },
        look('Marcus Kent', 'June Morrison'),
        emotion('Marcus Kent', 'earnest'),
        animate('Marcus Kent', 'one hand gesture'),
      ],
    ])]);
    expect(plan.clips).toHaveLength(1);
    expect(plan.clips[0].durationSeconds).toBe(6);
    expect(plan.clips[0].prompt).toBe([
      'WhispMax',
      '[characters]',
      JUNE,
      MARCUS,
      '[Location]',
      WAITING_ROOM,
      '[style]',
      STYLE,
      '[prompt]',
      'Shot 1 [0.000–2.583 seconds]: Close-up of June Morrison in the interrogation room, in the waiting room area. June Morrison turns toward the viewer, speaks with embarrassment and appears uneasy. June Morrison speaks with uneasy delivery. June Morrison says with uneasy delivery, “I don\'t know what to say.”',
      '',
      'Shot 2 [2.583–6.000 seconds]: The camera cuts to a close-up of Marcus Kent in the interrogation room, in the waiting room area. Marcus Kent turns toward the viewer, gestures with one hand and appears earnest. Marcus Kent speaks with delivery that shifts from earnest to hopeful. Marcus Kent says with earnest delivery, “Say that you love me.” With hopeful delivery: “That you understand.”',
    ].join('\n'));
  });

  it('reproduces the 15-second single-shot Marcus monologue caption byte for byte', () => {
    const plan = packWhispmaxClips([payload(2, [
      [enableSet('interrogation room'), addCharacter('Marcus Kent', 'interrogation room'), addCharacter('June Morrison', 'banish')],
      [
        {
          command: 'talk',
          args: {
            character: 'Marcus Kent', respondent: 'June Morrison',
            dialogue: '[firm] The bribe failed. [tense] You went to Jessica with cash — Autumn\'s problem, your solution — [disbelieving] and she laughed at you. [determined] That\'s where the vow came from, isn\'t it. You needed to prove you could actually fix it.',
            camera_shot: 'Character_CloseUp', camera_update: true, audio_duration: 14.6,
          },
        },
        look('Marcus Kent', 'June Morrison'),
        animate('Marcus Kent', 'finger point'),
      ],
    ])]);
    expect(plan.clips).toHaveLength(1);
    expect(plan.clips[0].prompt).toBe([
      'WhispMax',
      '[characters]',
      MARCUS,
      '[Location]',
      INTERROGATION_ROOM,
      '[style]',
      STYLE,
      '[prompt]',
      'Shot 1 [0.000–15.000 seconds]: Close-up of Marcus Kent in the interrogation room. Marcus Kent turns toward the viewer and points a finger. Marcus Kent speaks with delivery that shifts from firm to tense to disbelieving to determined. Marcus Kent says with firm delivery, “The bribe failed.” With tense delivery: “You went to Jessica with cash — Autumn\'s problem, your solution —” With disbelieving delivery: “and she laughed at you.” With determined delivery: “That\'s where the vow came from, isn\'t it. You needed to prove you could actually fix it.”',
    ].join('\n'));
    // Hard rule 1: the off-screen respondent never appears in [characters] or the prose.
    expect(plan.clips[0].visibleCharacters).toEqual(['Marcus Kent']);
  });
});

describe('visibility heuristic', () => {
  const talk = (character: string, respondent: string, cameraShot: string) => ({
    command: 'talk',
    args: { character, respondent, dialogue: '[calm] Look at me.', camera_shot: cameraShot, camera_update: true, audio_duration: 4.5 },
  });

  it('frames only the speaker on a close-up', () => {
    const plan = packWhispmaxClips([payload(1, [
      [enableSet('hotel lobby'), addCharacter('Marcus Kent', 'balcony'), addCharacter('Lily Song', 'balcony')],
      [talk('Marcus Kent', 'Lily Song', 'Character_CloseUp'), look('Marcus Kent', 'Lily Song')],
    ])]);
    expect(plan.clips[0].visibleCharacters).toEqual(['Marcus Kent']);
    expect(plan.clips[0].prompt).toContain('Marcus Kent turns toward the viewer.');
  });

  it('adds the staged respondent on a wider shot and keeps the named gaze', () => {
    const plan = packWhispmaxClips([payload(1, [
      [enableSet('hotel lobby'), addCharacter('Marcus Kent', 'balcony'), addCharacter('Lily Song', 'balcony')],
      [talk('Marcus Kent', 'Lily Song', 'Character_Medium'), look('Marcus Kent', 'Lily Song')],
    ])]);
    expect(plan.clips[0].visibleCharacters).toEqual(['Marcus Kent', 'Lily Song']);
    expect(plan.clips[0].prompt).toContain('Marcus Kent looks toward Lily Song.');
  });

  it('never frames a character staged in another zone or banished', () => {
    const other = packWhispmaxClips([payload(1, [
      [enableSet('hotel lobby'), addCharacter('Marcus Kent', 'balcony'), addCharacter('Lily Song', 'front desk')],
      [talk('Marcus Kent', 'Lily Song', 'Character_Medium'), look('Marcus Kent', 'Lily Song')],
    ])]);
    expect(other.clips[0].visibleCharacters).toEqual(['Marcus Kent']);
    const banished = packWhispmaxClips([payload(1, [
      [enableSet('hotel lobby'), addCharacter('Marcus Kent', 'banish'), addCharacter('Lily Song', 'banish')],
      [talk('Marcus Kent', 'Lily Song', 'Character_Medium'), look('Marcus Kent', 'Lily Song')],
    ])]);
    expect(banished.clips[0].visibleCharacters).toEqual(['Marcus Kent']);
    expect(banished.clips[0].zone).toBeUndefined();
    expect(banished.clips[0].warnings).toEqual([]);
  });
});

describe('clip packing', () => {
  const line = (character: string, audioDuration: number) => ({
    command: 'talk',
    args: { character, dialogue: '[calm] A line of dialogue here.', camera_shot: 'Character_Medium', camera_update: true, audio_duration: audioDuration },
  });

  it('packs consecutive beats up to 15 seconds and starts a new clip past the ceiling', () => {
    const plan = packWhispmaxClips([payload(1, [
      [enableSet('hotel lobby'), addCharacter('Marcus Kent', 'balcony'), addCharacter('Lily Song', 'balcony')],
      [line('Marcus Kent', 6)],
      [line('Lily Song', 6)],
      [line('Marcus Kent', 6)],
    ])]);
    // 6.3 + 6.3 fits; a third 6.3 would exceed 15.
    expect(plan.clips.map(clip => [clip.durationSeconds, clip.beats.length])).toEqual([[13, 2], [7, 1]]);
    expect(plan.clips[0].prompt).toContain('Shot 2 [6.300–13.000 seconds]');
  });

  it('never asks for less than the 5-second minimum', () => {
    const plan = packWhispmaxClips([payload(1, [
      [enableSet('black room'), addCharacter('Cassandra Vexon', 'banish')],
      [line('Cassandra Vexon', 1.2)],
    ])]);
    expect(plan.clips[0].durationSeconds).toBe(5);
    expect(plan.clips[0].prompt).toContain('Shot 1 [0.000–5.000 seconds]');
  });

  it('starts a new clip when the set or zone changes', () => {
    const plan = packWhispmaxClips([
      payload(1, [[enableSet('hotel lobby'), addCharacter('Marcus Kent', 'balcony')], [line('Marcus Kent', 5)]]),
      payload(2, [[enableSet('hotel lobby'), addCharacter('Marcus Kent', 'front desk')], [line('Marcus Kent', 5)]]),
      payload(3, [[enableSet('interrogation room'), addCharacter('Marcus Kent', 'office')], [line('Marcus Kent', 5)]]),
    ]);
    expect(plan.clips.map(clip => [clip.set, clip.zone])).toEqual([
      ['hotel lobby', 'balcony'], ['hotel lobby', 'front desk'], ['interrogation room', 'office'],
    ]);
  });

  it('ends the clip in progress on a cutscene hold', () => {
    const plan = packWhispmaxClips([payload(1, [
      [enableSet('hotel lobby'), addCharacter('Marcus Kent', 'balcony')],
      [line('Marcus Kent', 5)],
      [{ command: 'cutscene', args: { duration: 3 } }],
      [line('Marcus Kent', 5)],
    ])]);
    expect(plan.clips).toHaveLength(2);
    expect(plan.holds).toEqual([{ sequence: 1, groupId: 'g1-2', durationSeconds: 3 }]);
  });

  it('splits a single over-long line into consecutive clips at sentence boundaries', () => {
    const sentences = Array.from({ length: 8 }, (_, index) => `Sentence number ${index} runs on for a while here.`).join(' ');
    const plan = packWhispmaxClips([payload(1, [
      [enableSet('interrogation room'), addCharacter('Marcus Kent', 'interrogation room')],
      [{ command: 'talk', args: { character: 'Marcus Kent', dialogue: `[grim] ${sentences}`, camera_shot: 'Character_CloseUp', camera_update: true, audio_duration: 40 } }],
    ])]);
    expect(plan.clips.length).toBeGreaterThan(2);
    for (const clip of plan.clips) expect(clip.durationSeconds).toBeLessThanOrEqual(15);
    const spoken = plan.clips.flatMap(clip => clip.prompt.match(/“([^”]*)”/g) ?? []).join(' ');
    for (let index = 0; index < 8; index++) expect(spoken).toContain(`Sentence number ${index}`);
  });

  it('keeps sentence-boundary splitting for a line that fits inside the budget', () => {
    expect(splitDialogue('One. Two.', 4)).toEqual([{ dialogue: 'One. Two.', audioDuration: 4 }]);
  });
});

describe('whispers_1338 smoke test', () => {
  it('compiles the whole recording with no out-of-bible warnings', () => {
    const text = readFileSync(join(import.meta.dirname, 'fixtures', 'whispers-1338-trimmed.jsonl'), 'utf8');
    const rows = loadDssRecording(text);
    const sources: WhispmaxSourcePayload[] = rows.map(row => {
      const script = row.script as Record<string, unknown>;
      return {
        sequence: Number(script.sequence),
        storyBlockId: String(script.story_block_id ?? ''),
        groups: (script.command_groups as Array<Record<string, unknown>>).map(group => ({
          id: String(group.id),
          commands: group.commands as ReadonlyArray<Record<string, unknown>>,
        })),
      };
    });
    const plan = packWhispmaxClips(sources);
    expect(plan.clips.length).toBeGreaterThan(20);
    expect(plan.warnings).toEqual([]);
    for (const clip of plan.clips) {
      expect(clip.durationSeconds).toBeGreaterThanOrEqual(5);
      expect(clip.durationSeconds).toBeLessThanOrEqual(15);
      expect(clip.prompt.startsWith('WhispMax\n[characters]\n')).toBe(true);
      expect(clip.prompt).toContain('[Location]\n');
      expect(clip.prompt).toContain(STYLE);
      expect(clip.beats.length).toBeGreaterThan(0);
      for (const beat of clip.beats) expect(beat.audioUrl).toMatch(/^https:\/\//);
      const shots = clip.prompt.split('[prompt]\n')[1].split('\n\n');
      expect(shots).toHaveLength(clip.beats.length);
      expect(shots.at(-1)).toContain(`–${clip.durationSeconds.toFixed(3)} seconds]`);
    }
  });
});

describe('long bracketed stage directions', () => {
  it('reduces a multi-word direction to its leading adverb for the delivery grammar', () => {
    expect(deliveryCue('dry half to himself taking in the marble')).toBe('dry');
    expect(deliveryCue('forensic neutral')).toBe('forensic neutral');
    expect(deliveryCue('matter-of-fact')).toBe('matter-of-fact');
    expect(parseDeliverySegments('[low even a partner not a cheerleader] Hey.')).toEqual([
      { cue: 'low', text: 'Hey.' },
    ]);
  });
});
