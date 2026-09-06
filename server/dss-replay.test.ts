import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatReplaySummary, loadDssRecording, replayDss, type ReplayMedia } from './dss-replay.js';
import { generateVideo } from './fal.js';
import { extractVideoFrame } from './video-frame.js';

vi.mock('./fal.js', () => ({ generateVideo: vi.fn() }));
vi.mock('./video-frame.js', () => ({ extractVideoFrame: vi.fn() }));

type Json = Record<string, unknown>;
type Generated = Awaited<ReturnType<typeof generateVideo>>;

const storyBlockId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const talk = (character: string, respondent: string, shot = 'Character_CloseUp', dialogue = `Hello from ${character}.`): Json =>
  ({ command: 'talk', args: { character, respondent, dialogue, audio_duration: 5, camera_shot: shot } });
const setup: Json[] = [
  { command: 'enable set', args: { set: 'lobby' } },
  { command: 'add character', args: { name: 'Alex', point: { zone: 'lobby', mark: 'desk' } } },
  { command: 'add character', args: { name: 'Sam', point: { zone: 'lobby', mark: 'door' } } },
];
// Matches the kernel wire shape: metadata on the script, one group per payload.
const payload = (sequence: number, commands: Json[], sceneIndex = 1, episodeId = 7): Json => ({
  episode_id: episodeId, sequence, story_block_id: storyBlockId,
  script: { episode_id: episodeId, sequence, scene_index: sceneIndex, story_type: 4, story_block_id: storyBlockId, command_groups: [{ id: `group-${sequence}`, commands }] },
});
const story: Json[] = [
  payload(0, setup),
  payload(1, [talk('Alex', 'Sam')]),
  payload(2, [talk('Sam', 'Alex')]),
  payload(3, [talk('Alex', 'Sam')]),
  payload(4, [{ command: 'character move to', args: { character: 'Sam', location: { zone: 'lobby', mark: 'window' } } }, talk('Sam', 'Alex')]),
  payload(5, [{ command: 'show credits', args: { duration_seconds: 4 } }]),
];
const references = { characters: { Alex: { imageUrl: 'https://images.example/alex.png' }, Sam: { imageUrl: 'https://images.example/sam.png' } }, sets: { lobby: { imageUrl: 'https://images.example/lobby.png' } } };

afterEach(() => { vi.restoreAllMocks(); vi.mocked(generateVideo).mockReset(); vi.mocked(extractVideoFrame).mockReset(); });

describe('loadDssRecording', () => {
  it('accepts JSON arrays, JSONL, and capture rows, sorted by episode and sequence', () => {
    const rows = [{ received_at: 'x', event: payload(2, setup) }, { event: payload(1, setup) }, payload(0, setup, 1, 3)];
    const fromArray = loadDssRecording(JSON.stringify(rows));
    const fromLines = loadDssRecording(rows.map(row => JSON.stringify(row)).join('\n'));
    expect(fromArray.map(row => [row.episode_id, row.sequence])).toEqual([[3, 0], [7, 1], [7, 2]]);
    expect(fromLines).toEqual(fromArray);
  });
  it('drops identical duplicates and rejects conflicting ones', () => {
    expect(loadDssRecording(JSON.stringify([payload(1, setup), payload(1, setup)]))).toHaveLength(1);
    expect(() => loadDssRecording(JSON.stringify([payload(1, setup), payload(1, [talk('Alex', 'Sam')])]))).toThrow(/Conflicting duplicate/);
  });
});

describe('replayDss planning', () => {
  it('reports camera-anchor establish/reuse decisions and resets after blocking changes', async () => {
    const result = await replayDss(story, { rendererConfig: { model: 'fal-max-ref2v', continuity: 'camera-anchors' }, shotPlanner: references });
    expect(result.payloads).toEqual({ total: 6, replayedForStaging: 0, selected: 6, skipped: 0 });
    expect(result.shots.map(shot => [shot.sequence, shot.speaker, shot.dependency.kind])).toEqual([
      [1, 'Alex', 'anchor-establish'], [2, 'Sam', 'anchor-establish'], [3, 'Alex', 'anchor-reuse'], [4, 'Sam', 'anchor-establish'],
    ]);
    expect(result.shots[2].dependency).toMatchObject({ sourceShotId: result.shots[0].shotId });
    expect(result.shots[3].hasMovement).toBe(true);
    expect(result.controls).toEqual([{ sequence: 0, groupId: 'group-0', durationSeconds: 0 }, { sequence: 5, groupId: 'group-5', durationSeconds: 4 }]);
    expect(result.shots[0].imageReferences.map(reference => reference.name)).toContain('Alex');
    expect(generateVideo).not.toHaveBeenCalled();
    expect(formatReplaySummary(result)).toContain('#3 seq 3 5s [anchor: reuse #1]');
  });

  it('replays staging before a selected range but chooses anchor sources only inside it', async () => {
    const result = await replayDss(story, { rendererConfig: { model: 'fal-max-ref2v', continuity: 'camera-anchors' }, shotPlanner: references, from: 3, to: 4 });
    expect(result.payloads).toMatchObject({ replayedForStaging: 4, selected: 2 });
    expect(result.shots.map(shot => [shot.sequence, shot.dependency.kind])).toEqual([[3, 'anchor-establish'], [4, 'anchor-establish']]);
    // Staging from the replayed setup payload still reaches the compiled prompt.
    expect(result.shots[0].prompt).toMatch(/Sam/);
  });

  it('chains Turbo shots within a scene and restarts on a scene change', async () => {
    const scenes = [payload(0, setup), payload(1, [talk('Alex', 'Sam')]), payload(2, [talk('Sam', 'Alex')]), payload(3, setup, 2), payload(4, [talk('Alex', 'Sam')], 2)];
    const result = await replayDss(scenes, { rendererConfig: { model: 'fal-turbo-i2v' }, initialImageUrl: 'https://images.example/opening.png' });
    expect(result.shots.map(shot => shot.dependency.kind)).toEqual(['chain-start', 'chain', 'chain-start']);
    expect(result.shots[1].dependency).toMatchObject({ sourceShotId: result.shots[0].shotId });
  });

  it('keeps compiling after a payload the compiler rejects, and reports it', async () => {
    const broken = [payload(0, setup), payload(1, [{ command: 'teleport', args: {} }]), payload(2, [talk('Alex', 'Sam')])];
    const result = await replayDss(broken, { rendererConfig: { model: 'fal-max-ref2v', continuity: 'none' }, shotPlanner: references });
    expect(result.warnings).toEqual([expect.stringMatching(/Sequence 1 .*Unsupported DSS command: teleport/)]);
    expect(result.shots.map(shot => shot.sequence)).toEqual([2]);
  });

  it('rejects the configured-provider mode and Turbo without an opening frame', async () => {
    await expect(replayDss(story, { rendererConfig: { model: 'auto' } })).rejects.toThrow(/explicit fal modes/);
    await expect(replayDss(story, { rendererConfig: { model: 'fal-turbo-i2v' } })).rejects.toThrow(/initialImageUrl/);
  });
});

describe('replayDss rendering', () => {
  let outDir: string;
  afterEach(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

  it('generates through the shared continuity policy, then downloads, normalizes, and assembles in order', async () => {
    outDir = await mkdtemp(join(tmpdir(), 'dss-replay-'));
    const submitted: string[] = [];
    vi.mocked(generateVideo).mockImplementation(async input => {
      submitted.push(input.prompt);
      const name = `clip-${submitted.length}`;
      return { videoUrl: `https://fal.media/${name}.mp4`, requestId: name, timings: { submitSeconds: 0.1, queueSeconds: 1, totalSeconds: 2, polls: 1 } } as Generated;
    });
    vi.mocked(extractVideoFrame).mockImplementation(async url => `data:image/jpeg;base64,${Buffer.from(url).toString('base64')}`);
    const calls: string[] = [];
    const media: ReplayMedia = {
      download: async (url, path) => { calls.push(`download ${url} -> ${path.split('/').at(-1)}`); },
      normalize: async (input, output, duration, offset) => { calls.push(`normalize ${input.split('/').at(-1)} ${duration}s @${offset}`); void output; },
      concat: async (inputs, output) => { calls.push(`concat ${inputs.length} -> ${output.split('/').at(-1)}`); },
    };
    const result = await replayDss(story, {
      rendererConfig: { model: 'fal-max-ref2v', continuity: 'camera-anchors', concurrency: 2, maxBufferedSeconds: 10 },
      shotPlanner: references, render: { apiKey: 'fixture', outDir, media },
    });
    expect(result.output).toMatchObject({ failures: 0, moviePath: join(outDir, 'story.mp4') });
    expect(result.shots.every(shot => shot.generated)).toBe(true);
    // The reused anchor received its source's extracted frame as the extra reference.
    const reuse = vi.mocked(generateVideo).mock.calls[2][0];
    expect(reuse.referenceImageUrls?.at(-1)).toMatch(/^data:image\/jpeg;base64,/);
    expect(reuse.prompt).toMatch(/established frame for this camera setup/);
    expect(calls).toEqual([
      'download https://fal.media/clip-1.mp4 -> 001-seq1.mp4', 'normalize 001-seq1.mp4 5s @0',
      'download https://fal.media/clip-2.mp4 -> 002-seq2.mp4', 'normalize 002-seq2.mp4 5s @5',
      'download https://fal.media/clip-3.mp4 -> 003-seq3.mp4', 'normalize 003-seq3.mp4 5s @10',
      'download https://fal.media/clip-4.mp4 -> 004-seq4.mp4', 'normalize 004-seq4.mp4 5s @15',
      'concat 4 -> story.mp4',
    ]);
    expect(result.timing).toMatchObject({ videoSeconds: 20, providerSeconds: 8 });
    expect(result.shots[0].generated?.continuityFrame).toBe('[frame]');
  });

  it('records a failed shot, skips assembly, and still releases the budget for later shots', async () => {
    outDir = await mkdtemp(join(tmpdir(), 'dss-replay-'));
    let count = 0;
    vi.mocked(generateVideo).mockImplementation(async () => {
      count += 1;
      if (count === 2) throw new Error('provider rejected');
      return { videoUrl: `https://fal.media/clip-${count}.mp4`, timings: { submitSeconds: 0, queueSeconds: 0, totalSeconds: 1, polls: 1 } } as Generated;
    });
    const media: ReplayMedia = { download: async () => undefined, normalize: async () => undefined, concat: vi.fn(async () => undefined) };
    const result = await replayDss(story, {
      rendererConfig: { model: 'fal-max-ref2v', continuity: 'none', concurrency: 1, maxBufferedSeconds: 5 },
      shotPlanner: references, render: { apiKey: 'fixture', outDir, media },
    });
    expect(result.output).toMatchObject({ failures: 1, moviePath: null });
    expect(result.shots.map(shot => Boolean(shot.error))).toEqual([false, true, false, false]);
    expect(media.concat).not.toHaveBeenCalled();
    expect(formatReplaySummary(result)).toMatch(/FAILED provider rejected/);
    await expect(readFile(join(outDir, 'clips', 'missing'), 'utf8')).rejects.toThrow();
  });
});
