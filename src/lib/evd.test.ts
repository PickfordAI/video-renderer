import { describe, expect, it } from 'vitest';

import { matchImportedEpisode, parseCvdOrEvdExport, splitBeatDescription } from './evd';

const document = {
  scenes: [
    {
      title: 'The arrival',
      explanation: 'The host realizes the guest is early',
      variants: [
        {
          label: 'storm',
          set_name: 'old manor foyer',
          story_blocks: [
            { description: 'The door opens and rain blows across the marble floor.' },
            { description: 'The host hides a bloodstained letter.' },
          ],
        },
      ],
    },
  ],
};

describe('parseCvdOrEvdExport', () => {
  it('extracts episodes and cinematic prompts from a CVD export bundle', () => {
    const show = parseCvdOrEvdExport(
      {
        bundle_version: 1,
        cvd: { name: 'Whispers', story_type: 'WHISPERS' },
        cast_members: [{ name: 'The Host' }],
        evds: [{ id: 'c7dfcb7c-5908-48bc-851c-f39f67a04ac4', name: 'Pilot', episode_number: 1, document }],
      },
      'Imported show',
      { durationSeconds: 10 },
    );

    expect(show.name).toBe('Whispers');
    expect(show.storyType).toBe('WHISPERS');
    expect(show.episodes[0].beats).toHaveLength(2);
    expect(show.episodes[0].serviceEvdId).toBe('c7dfcb7c-5908-48bc-851c-f39f67a04ac4');
    expect(show.episodes[0].beats[0]).toMatchObject({
      title: 'The arrival · storm',
      sceneIndex: 0,
      blockIndex: 0,
      source: 'imported',
    });
    expect(show.episodes[0].beats[0].prompt).toContain('old manor foyer');
    expect(show.episodes[0].beats[0].prompt).toContain('rain blows across the marble floor');
  });

  it('attaches mentioned exported cast names to imported shots', () => {
    const show = parseCvdOrEvdExport({
      cvd: { name: 'Creator mystery', story_type: 'CREATOR' },
      cast_members: [{ name: 'Nora Vale' }, { name: 'Eli Frost' }],
      evds: [{ name: 'Pilot', episode_number: 1, document: {
        scenes: [{ variants: [{ story_blocks: [{ description: 'Nora Vale studies the rain-soaked letter.' }] }] }],
      } }],
    });

    expect(show.episodes[0].beats[0].characterNames).toEqual(['Nora Vale']);
  });

  it('accepts a single EVD export and uses the filename as the show name', () => {
    const show = parseCvdOrEvdExport({ name: 'Episode two', episode_number: 2, document }, 'mystery.json');
    expect(show.name).toBe('mystery');
    expect(show.episodes[0]).toMatchObject({ name: 'Episode two', episodeNumber: 2 });
  });

  it('accepts a raw EVD document', () => {
    const show = parseCvdOrEvdExport(document, 'raw-episode.json', { durationSeconds: 10 });
    expect(show.episodes[0].beats).toHaveLength(2);
    expect(show.episodes[0].serviceEvdId).toBeNull();
    expect(show.episodes[0].id).toBe('episode-0');
  });

  it('recognizes evd_id but never treats an arbitrary row id as a service EVD UUID', () => {
    const withEvdId = parseCvdOrEvdExport({ evd_id: 'c7dfcb7c-5908-48bc-851c-f39f67a04ac4', document });
    const withSyntheticId = parseCvdOrEvdExport({ id: 'episode-0', document });
    expect(withEvdId.episodes[0].serviceEvdId).toBe('c7dfcb7c-5908-48bc-851c-f39f67a04ac4');
    expect(withSyntheticId.episodes[0].serviceEvdId).toBeNull();
  });

  it('splits long prose at semantic boundaries sized for the clip duration', () => {
    const chunks = splitBeatDescription(
      'Nora opens the door and steps into rain. She sees the letter, but waits before picking it up. The hall falls silent.',
      5,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toBe('Nora opens the door and steps into rain.');
    expect(chunks.every((chunk) => chunk.split(/\s+/).length <= 9)).toBe(true);
    expect(chunks.join(' ')).toContain('The hall falls silent.');
  });

  it('keeps the same prose together when a longer clip has enough room', () => {
    const description = 'Nora opens the door. She pauses before stepping into the rain.';
    expect(splitBeatDescription(description, 10)).toEqual([description]);
  });

  it('uses template prose and removes unresolved variables from structured descriptions', () => {
    const structuredDocument = {
      scenes: [{
        title: 'Evidence',
        variants: [{
          label: 'default',
          set_name: 'lab',
          story_blocks: [{
            description: {
              pickford_template: 'v1',
              template: 'Cassandra studies the evidence. {{dep:killer:Nathan}} Kent waits for her answer.',
              dependencies: {},
            },
          }],
        }],
      }],
    };
    const show = parseCvdOrEvdExport(structuredDocument, 'structured.json', { durationSeconds: 10 });

    expect(show.episodes[0].beats).toHaveLength(1);
    expect(show.episodes[0].beats[0].prompt).toContain('Cassandra studies the evidence. Kent waits for her answer.');
    expect(show.episodes[0].beats[0].prompt).not.toContain('{{dep:');
  });

  it('rejects documents without renderable story blocks', () => {
    expect(() => parseCvdOrEvdExport({ document: { scenes: [] } })).toThrow('No renderable EVD story blocks');
  });
});

describe('matchImportedEpisode', () => {
  it('matches an identity-free export to its server-side draft by show and episode number', () => {
    const imported = parseCvdOrEvdExport({
      cvd: { name: 'Whispers', story_type: 'WHISPERS' },
      evds: [{ name: 'The Arrival', episode_number: 2, document }],
    });
    const draft = {
      id: 'c7dfcb7c-5908-48bc-851c-f39f67a04ac4',
      cvd_id: '6fb6f7fc-a594-46d2-8bcd-f133c6866fb9',
      cvd_name: 'Whispers',
      name: 'The Arrival',
      episode_number: 2,
      is_active: true,
      is_published: false,
    };

    expect(matchImportedEpisode([draft], imported, imported.episodes[0])).toEqual(draft);
  });
});
