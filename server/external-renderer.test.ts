import { describe, expect, it } from 'vitest';

import {
  controlGroupDurationSeconds,
  createCommandProgressEvent,
  createGroupFinishedEvent,
  classifyStoryLifecycle,
  createRendererAudienceMessage,
  parseRendererAudienceResult,
  planGroupClips,
  parseExternalRendererRunConfig,
} from './external-renderer.js';

const rendererId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const credentialId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const roomId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const roomShortlink = 'ROOM42';
const storyChannelId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const roomChannelId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function config() {
  return {
    rendererId,
    credentialId,
    clientSecret: 'test-only-secret',
    rendererVersion: 'h3.20260903.edge.1',
    storyId: 42,
    roomId,
    roomShortlink,
    storyMessageChannelId: storyChannelId,
    roomMainMessageChannelId: roomChannelId,
    storyConfig: {
      base_structure: 'MINIMAX',
      evd_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      message_channel_ids: [storyChannelId],
    },
    enableAudience: true,
  };
}

describe('external renderer run configuration', () => {
  it('uses service defaults without generating synthetic audience traffic', () => {
    const parsed = parseExternalRendererRunConfig(config());

    expect(parsed.baseUrl).toBe('https://edge.pickford.ai');
    expect(parsed).not.toHaveProperty('audienceMessages');
    expect(parsed.resolution).toBe('480P');
    expect(parsed.roomShortlink).toBe(roomShortlink);
  });

  it('accepts a local bridge without audience-only room metadata', () => {
    const parsed = parseExternalRendererRunConfig({
      environment: 'local',
      baseUrl: 'http://host.docker.internal:8193',
      websocketUrl: 'ws://host.docker.internal:8193/api/v1/renderer-bridge/ws',
      rendererId,
      credentialId,
      clientSecret: 'test-only-secret',
      rendererVersion: 'minimax.20260904.local.1',
      resumeExistingStory: true,
    });

    expect(parsed).not.toHaveProperty('enableAudience');
    expect(parsed.tier).toBe('renderer-dev');
  });

  it('rejects the room-main channel in story configuration', () => {
    const value = config();
    value.storyConfig.message_channel_ids = [roomChannelId];

    expect(() => parseExternalRendererRunConfig(value)).toThrow(
      'storyConfig.message_channel_ids must contain only storyMessageChannelId',
    );
  });

  it('requires distinct story and room-main channels', () => {
    const value = config();
    value.roomMainMessageChannelId = storyChannelId;

    expect(() => parseExternalRendererRunConfig(value)).toThrow('story and room-main channels must be distinct');
  });

  it('rejects a start configuration that could fall through to the wrong story type', () => {
    const value = config();
    expect(() => parseExternalRendererRunConfig({
      ...value,
      storyConfig: { message_channel_ids: [storyChannelId] },
    })).toThrow('storyConfig.evd_id is required');
    expect(() => parseExternalRendererRunConfig({
      ...value,
      storyConfig: { ...value.storyConfig, base_structure: 'FIRST_DATE' },
    })).toThrow('storyConfig.base_structure must be MINIMAX, CREATOR, or WHISPERS');
  });
});

describe('story lifecycle observation', () => {
  it('does not treat the initially inactive prepared story as completed', () => {
    expect(classifyStoryLifecycle({ active: false, running_key: null, errors: null }, false, false).state).toBe('running');
  });

  it('reports authoritative end only after running or receiving an assignment', () => {
    const running = classifyStoryLifecycle({ active: true, running_key: 'story-key', errors: null }, false, false);
    expect(classifyStoryLifecycle({ active: false, running_key: null, errors: null }, running.observedRunning, false).state).toBe('ended');
    expect(classifyStoryLifecycle({ active: false, running_key: null, errors: null }, false, true).state).toBe('ended');
  });

  it('reports persisted story errors as failures', () => {
    expect(classifyStoryLifecycle({
      active: false,
      running_key: null,
      errors: { story_error_type: 'renderer_unavailable' },
    }, true, false)).toMatchObject({ state: 'failed', failure: 'renderer_unavailable' });
  });
});

describe('renderer audience relay protocol', () => {
  it('binds the browser message to the active story without browser-supplied auth or channel data', () => {
    const message = createRendererAudienceMessage(42, {
      externalSubject: 'viewer:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      displayName: 'Ada',
      content: 'Turn left',
    });
    expect(message).toEqual({
      type: 'audience.message',
      protocol_version: 1,
      story_id: 42,
      external_subject: 'viewer:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      message_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      display_name: 'Ada',
      content: 'Turn left',
    });
    expect(message).not.toHaveProperty('message_channel_id');
    expect(message).not.toHaveProperty('token');
  });

  it('correlates accepted, duplicate, and rejected acknowledgements without exposing principals', () => {
    expect(parseRendererAudienceResult({
      type: 'audience.message.accepted', source_message_id: 'source-1', message_id: storyChannelId,
    })).toEqual({ key: 'source-1', result: { accepted: true, duplicate: false, messageId: storyChannelId } });
    expect(parseRendererAudienceResult({
      type: 'audience.message.duplicate', source_message_id: 'source-2', message_id: roomChannelId,
    })?.result).toMatchObject({ accepted: true, duplicate: true });
    expect(parseRendererAudienceResult({
      type: 'audience.message.rejected', source_message_id: 'source-3', code: 'rate_limited', detail: 'Try later', retry_after_seconds: 2,
    })).toEqual({
      key: 'source-3',
      result: { accepted: false, code: 'rate_limited', detail: 'Try later', retryAfterSeconds: 2 },
    });
  });
});

describe('createCommandProgressEvent', () => {
  it('uses the canonical command-group message ID and preserves DSS correlation', () => {
    expect(createCommandProgressEvent({
      streamId: rendererId,
      assignmentId: 'assignment-1',
      assignmentGeneration: 4,
      sequence: 7,
      status: 'completed',
      groupId: 'group-9',
      current: 3,
      total: 3,
      storyBlockId: roomId,
    })).toMatchObject({
      type: 'renderer.event',
      event: 'command_progress',
      id: 10,
      stream_id: rendererId,
      assignment_id: 'assignment-1',
      assignment_generation: 4,
      sequence: 7,
      status: 'completed',
      group_id: 'group-9',
      current: 3,
      total: 3,
      story_block_id: roomId,
    });
  });

  it('uses the documented terminal ScriptStatus envelope after playback', () => {
    expect(createGroupFinishedEvent({
      streamId: rendererId,
      assignmentId: 'assignment-1',
      assignmentGeneration: 4,
      sequence: 7,
      groupId: 'group-9',
      storyBlockId: roomId,
      durationSeconds: 12,
    })).toMatchObject({
      type: 'renderer.event',
      event: 'completed',
      id: 6,
      stream_id: rendererId,
      assignment_id: 'assignment-1',
      assignment_generation: 4,
      sequence: 7,
      status: 10,
      duration: 12,
      dss_id: 'group-9',
      story_block_id: roomId,
    });
  });
});

describe('planGroupClips', () => {
  it('keeps dialogue turns as ordered child clips in one command group', () => {
    const clips = planGroupClips(
      {
        raw: {},
        sequence: 3,
        assignmentId: 'assignment-1',
        assignmentGeneration: 1,
        storyBlockId: roomId,
        groups: [],
      },
      {
        id: 'group-1',
        commands: [
          { command: 'EnableSet', args: { set: 'Cafe' } },
          { command: 'Talk', args: { character: 'June', dialogue: 'First line.' } },
          { command: 'Talk', args: { character: 'Marcus', dialogue: 'Second line.' } },
        ],
      },
      6,
    );

    expect(clips).toHaveLength(2);
    expect(clips[0]?.prompt).toContain('June speaks: “First line.”');
    expect(clips[1]?.prompt).toContain('Marcus speaks: “Second line.”');
  });
});


describe('StoryKernel setup and transition commands', () => {
  const frame = { raw: {}, sequence: 1, assignmentId: 'assignment-1', assignmentGeneration: 1, storyBlockId: roomId, groups: [] };

  it('carries setup context to dialogue without generating setup clips', () => {
    const context: string[] = [];
    const setup = { id: 'setup', commands: [
      { command: 'enable set', args: { set: 'hotel lobby' } },
      { command: 'cutscene', args: { duration_seconds: 10 } },
      { command: 'show debug', args: { show: false } },
      { command: 'set fps', args: { fps: 24 } },
      { command: 'add character', args: { character: 'marcus' } },
    ] };
    expect(planGroupClips(frame, setup, 5, context)).toEqual([]);
    expect(controlGroupDurationSeconds(setup)).toBe(10);
    const clips = planGroupClips(frame, { id: 'dialogue', commands: [
      { command: 'talk', args: { character: 'marcus', dialogue: 'We meet again.' } },
    ] }, 5, context);
    expect(clips).toHaveLength(1);
    expect(clips[0]?.prompt).toContain('Setting: hotel lobby.');
    expect(clips[0]?.prompt).toContain('marcus is present');
    expect(clips[0]?.prompt).toContain('We meet again.');
  });

  it('honors transition duration even when transport delay is zero', () => {
    const group = { id: 'fade', commands: [{ command: 'fade', delay: 0, blocking: true, args: { wait: true, duration: 2, 'fade in': true } }] };
    expect(planGroupClips(frame, group, 5)).toEqual([]);
    expect(controlGroupDurationSeconds(group)).toBe(2);
  });

  it('does not silently accept unknown commands alongside valid dialogue', () => {
    expect(() => planGroupClips(frame, { id: 'unknown', commands: [
      { command: 'talk', args: { dialogue: 'Hello.' } },
      { command: 'unsupported movement', args: {} },
    ] }, 5)).toThrow('Unsupported DSS command: unsupported movement');
  });
});


describe('StoryKernel look direction', () => {
  const frame = { raw: {}, sequence: 1, assignmentId: 'assignment-1', assignmentGeneration: 1, storyBlockId: roomId, groups: [] };

  it('includes a look command following dialogue in the same shot and retains gaze context', () => {
    const context: string[] = [];
    const clips = planGroupClips(frame, { id: 'talk-look', commands: [
      { command: 'talk', args: { character: 'Richard Cho', dialogue: 'A truly lamentable situation.', respondent: 'Lily Song' } },
      { command: 'look', args: { character: 'Richard Cho', target: { type: 'Character', name: 'Lily Song', bias: 'eyes' } } },
    ] }, 5, context);
    expect(clips).toHaveLength(1);
    expect(clips[0]?.prompt).toContain('Richard Cho looks toward Lily Song, making eye contact.');
    expect(clips[0]?.prompt).toContain('A truly lamentable situation.');
    const next = planGroupClips(frame, { id: 'next', commands: [
      { command: 'talk', args: { character: 'Lily Song', dialogue: 'Indeed.' } },
    ] }, 5, context);
    expect(next[0]?.prompt).toContain('Richard Cho looks toward Lily Song');
  });

  it('rejects a malformed gaze target rather than acknowledging it silently', () => {
    expect(() => planGroupClips(frame, { id: 'bad-look', commands: [
      { command: 'look', args: { character: 'Richard Cho', target: { type: 'Character' } } },
    ] }, 5)).toThrow('look target name');
  });
});
