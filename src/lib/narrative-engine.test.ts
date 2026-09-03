import { describe, expect, it } from 'vitest';

import {
  createAndStartShow,
  joinAndReadRoom,
  listAvailableEvds,
  openDssEvents,
  pickActiveMessageChannel,
  reportExternalPlaybackState,
} from './narrative-engine';
import { createDefaultCharacterReferences } from './character-references';
import type { RendererSettings } from './types';

const settings: RendererSettings = {
  narrativeEngineUrl: 'http://engine.example/',
  narrativeAuthoringUrl: 'http://authoring.example/',
  realtimeGatewayUrl: 'http://realtime.example/',
  chatBackendUrl: 'http://chat.example',
  setupMode: 'create',
  roomName: 'H3 live test',
  roomShortlink: 'cobalt-fox',
  evdId: 'c7dfcb7c-5908-48bc-851c-f39f67a04ac4',
  storyType: 'WHISPERS',
  sessionToken: 'secret-token',
  autoRender: false,
  useCharacterReferences: true,
  characterReferences: createDefaultCharacterReferences(),
  resolution: '768P',
  duration: 5,
};

describe('pickActiveMessageChannel', () => {
  it('prefers the active channel for the room active story', () => {
    expect(
      pickActiveMessageChannel({
        id: 'room-1',
        active_story_id: 42,
        message_channels: [
          { id: 'old', state: 'ACTIVE', story_id: 41, created_at: '2026-08-31T10:00:00Z' },
          { id: 'current', state: 'ACTIVE', story_id: 42, created_at: '2026-08-31T09:00:00Z' },
          { id: 'closed', state: 'CLOSED', story_id: 42, created_at: '2026-08-31T11:00:00Z' },
        ],
      })?.id,
    ).toBe('current');
  });

  it('returns null when the service supplies no channels', () => {
    expect(pickActiveMessageChannel({ id: 'room-1' })).toBeNull();
  });
});

describe('same-origin Narrative Engine transport', () => {
  it('joins through the renderer server instead of fetching the external API in the browser', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let requestBody = '';
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ id: 'room-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await expect(joinAndReadRoom(settings)).resolves.toMatchObject({ id: 'room-1' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestUrl).toBe('/api/narrative/room');
    expect(JSON.parse(requestBody)).toEqual({
      baseUrl: 'http://engine.example',
      shortlink: 'cobalt-fox',
      token: 'secret-token',
    });
  });

  it('starts a Narrative Engine show through the renderer server', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let requestBody = '';
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? '');
      return new Response(JSON.stringify({
        room: { id: 'room-1', shortlink: 'new-room' },
        show: { playthrough_id: 'playthrough-1', episode_id: 42, episode_number: 1, total_episodes: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      await expect(createAndStartShow(settings)).resolves.toMatchObject({ room: { shortlink: 'new-room' } });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestUrl).toBe('/api/narrative/start-show');
    expect(JSON.parse(requestBody)).toEqual({
      baseUrl: 'http://engine.example',
      token: 'secret-token',
      roomName: 'H3 live test',
      evdId: 'c7dfcb7c-5908-48bc-851c-f39f67a04ac4',
      storyType: 'WHISPERS',
    });
  });

  it('loads available EVDs through the renderer server without putting the token in a URL', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let requestBody = '';
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? '');
      return new Response(JSON.stringify([{
        id: settings.evdId,
        cvd_id: '6fb6f7fc-a594-46d2-8bcd-f133c6866fb9',
        cvd_name: 'Whispers',
        name: 'Pilot',
        episode_number: 1,
        is_active: true,
        is_published: true,
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      await expect(listAvailableEvds(settings)).resolves.toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestUrl).toBe('/api/narrative/available-evds');
    expect(requestUrl).not.toContain('secret-token');
    expect(JSON.parse(requestBody)).toEqual({
      baseUrl: 'http://authoring.example',
      token: 'secret-token',
      storyType: 'WHISPERS',
    });
  });

  it('reports external playback bookkeeping through the same-origin server', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let requestBody = '';
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body ?? '');
      return new Response(JSON.stringify({
        story_id: 42,
        update_id: '570a320b-89d9-4aea-ada3-e8c8b9768fe4',
        accepted_played_through_sequence: 3,
        completion_frontier: 3,
        highest_sent_sequence: 6,
        desired_runway_seconds: 30,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const state = {
      update_id: '570a320b-89d9-4aea-ada3-e8c8b9768fe4',
      played_through_sequence: 3,
      ready_video_seconds: 10,
      generating_video_seconds: 15,
      generation_latency_p90_ms: 20_000,
      desired_runway_seconds: 30,
    };
    try {
      await expect(reportExternalPlaybackState(settings, 'room-1', state)).resolves.toMatchObject({
        completion_frontier: 3,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestUrl).toBe('/api/narrative/external-playback-state');
    expect(JSON.parse(requestBody)).toEqual({
      baseUrl: 'http://engine.example',
      roomId: 'room-1',
      token: 'secret-token',
      state,
    });
  });

  it('surfaces local proxy errors returned in the error field', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: 'EVD ID must be a UUID' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
    try {
      await expect(createAndStartShow(settings)).rejects.toThrow('400: EVD ID must be a UUID');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('opens DSS SSE through the renderer origin', () => {
    const OriginalEventSource = globalThis.EventSource;
    let sourceUrl = '';
    class FakeEventSource {
      onerror = null;
      constructor(url: string | URL) { sourceUrl = String(url); }
      addEventListener() {}
      close() {}
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    try {
      openDssEvents(settings, () => {}, () => {});
    } finally {
      globalThis.EventSource = OriginalEventSource;
    }
    expect(sourceUrl).toContain('/api/narrative/dss-events?');
    expect(sourceUrl).toContain('base_url=http%3A%2F%2Frealtime.example');
    expect(sourceUrl).toContain('live_only=false');
    expect(sourceUrl).not.toContain('http://realtime.example/dss-events');
  });

  it('joins an existing show at the live edge instead of replaying its retained history', () => {
    const OriginalEventSource = globalThis.EventSource;
    let sourceUrl = '';
    class FakeEventSource {
      onerror = null;
      constructor(url: string | URL) { sourceUrl = String(url); }
      addEventListener() {}
      close() {}
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    try {
      openDssEvents({ ...settings, setupMode: 'join' }, () => {}, () => {});
    } finally {
      globalThis.EventSource = OriginalEventSource;
    }
    expect(sourceUrl).toContain('live_only=true');
  });
});
