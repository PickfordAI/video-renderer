import { describe, expect, it } from 'vitest';

import {
  createCommandProgressEvent,
  createGroupFinishedEvent,
  planGroupClips,
  parseExternalRendererRunConfig,
} from './external-renderer.js';

const rendererId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const credentialId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const roomId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
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
    storyMessageChannelId: storyChannelId,
    roomMainMessageChannelId: roomChannelId,
    storyConfig: { message_channel_ids: [storyChannelId] },
  };
}

describe('external renderer run configuration', () => {
  it('pins edge defaults and requires at least one hundred audience messages', () => {
    const parsed = parseExternalRendererRunConfig(config());

    expect(parsed.baseUrl).toBe('https://edge.pickford.ai');
    expect(parsed.chatBaseUrl).toBe('https://chat.edge.pickford.ai');
    expect(parsed.audienceMessages).toBe(100);
    expect(parsed.resolution).toBe('480P');
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
  it('keeps a command group together in one ordered video clip', () => {
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

    expect(clips).toHaveLength(1);
    expect(clips[0]?.prompt).toContain('June speaks: “First line.” Then Marcus speaks: “Second line.”');
  });
});
