import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { handleNarrativeEngineApi } from './narrative-engine.js';

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

async function proxyServer(): Promise<string> {
  return listen(createServer(async (request, response) => {
    if (!(await handleNarrativeEngineApi(request, response))) {
      response.writeHead(404).end();
    }
  }));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('Narrative Engine server proxy', () => {
  it('joins a room server-to-server without exposing the upstream origin to browser CORS', async () => {
    let authorization = '';
    const upstream = await listen(createServer((request, response) => {
      authorization = request.headers.authorization ?? '';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'room-1', name: 'Whispers' }));
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: upstream, shortlink: 'cobalt-fox', token: 'session-token' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'room-1' });
    expect(authorization).toBe('Bearer session-token');
  });

  it('retains the room-read fallback when join is unavailable', async () => {
    const paths: string[] = [];
    const upstream = await listen(createServer((request, response) => {
      paths.push(request.url ?? '');
      if (request.url === '/room/join') {
        response.writeHead(409, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ detail: 'already joined' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'room-existing' }));
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: upstream, shortlink: 'cobalt fox', token: 'token' }),
    });

    expect(await response.json()).toMatchObject({ id: 'room-existing' });
    expect(paths).toEqual([
      '/room/join',
      '/room/?shortlink=cobalt%20fox&include_most_recent_story=true',
    ]);
  });

  it('preserves an authentication failure instead of masking it with a room lookup', async () => {
    const paths: string[] = [];
    const upstream = await listen(createServer((request, response) => {
      paths.push(request.url ?? '');
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ detail: 'Invalid session token' }));
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: upstream, shortlink: 'cobalt-fox', token: 'bad-token' }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: 'Invalid session token' });
    expect(paths).toEqual(['/room/join']);
  });

  it('creates, joins, configures, starts, and rereads an EVD-backed show in order', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const upstream = await listen(createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body: text ? JSON.parse(text) as unknown : null,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.method === 'POST' && request.url === '/room/') {
        response.end(JSON.stringify({ id: 'room-1', shortlink: 'h3-show' }));
      } else if (request.method === 'POST' && request.url === '/show/start') {
        response.end(JSON.stringify({ playthrough_id: 'p-1', episode_id: 8, episode_number: 1, total_episodes: 3 }));
      } else if (request.method === 'GET') {
        response.end(JSON.stringify({ id: 'room-1', shortlink: 'h3-show', active_story_id: 8, message_channels: [] }));
      } else {
        response.end(JSON.stringify({ id: 'room-1', shortlink: 'h3-show' }));
      }
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/start-show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: upstream,
        token: 'session-token',
        roomName: 'H3 Show',
        evdId: 'c7dfcb7c-5908-48bc-851c-f39f67a04ac4',
        storyType: 'CREATOR',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      room: { shortlink: 'h3-show', active_story_id: 8 },
      show: { episode_id: 8, total_episodes: 3 },
    });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/room/',
        body: { name: 'H3 Show', visibility: 'PRIVATE', state: 'ACTIVE', redundant_renderer_count: 1, story_type: 'CREATOR' },
      },
      { method: 'POST', path: '/room/join', body: { shortlink: 'h3-show' } },
      { method: 'PATCH', path: '/room/playback-mode', body: { room_id: 'room-1', mode: 'external_renderer' } },
      {
        method: 'POST',
        path: '/show/start',
        body: {
          evd_id: 'c7dfcb7c-5908-48bc-851c-f39f67a04ac4',
          room_shortlink: 'h3-show',
          character_ids: [],
          config: {},
        },
      },
      {
        method: 'GET',
        path: '/room/?shortlink=h3-show&include_most_recent_story=true',
        body: null,
      },
    ]);
  });

  it('provisions an inactive story with a distinct room-bound audience channel', async () => {
    const roomId = '11111111-1111-4111-8111-111111111111';
    const roomChannelId = '22222222-2222-4222-8222-222222222222';
    const storyChannelId = '33333333-3333-4333-8333-333333333333';
    const evdId = '44444444-4444-4444-8444-444444444444';
    const calls: Array<{ method: string; path: string; body: unknown; authorization: string }> = [];
    let storyChannelCreated = false;
    const upstream = await listen(createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) as unknown : null;
      calls.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body,
        authorization: request.headers.authorization ?? '',
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url === '/auth/login') response.end(JSON.stringify({ session_token: 'fresh-session' }));
      else if (request.url === '/room/') response.end(JSON.stringify({ id: roomId, shortlink: 'public-h3' }));
      else if (request.url === '/story/') response.end(JSON.stringify({ id: 14 }));
      else if (request.url === `/message_channel/?room_id=${roomId}`) {
        response.end(JSON.stringify([{ id: roomChannelId, state: 'ACTIVE', room_id: roomId, story_id: null }]));
      } else if (request.url === '/message_channel/?story_id=14') {
        response.end(JSON.stringify(storyChannelCreated
          ? [{ id: storyChannelId, state: 'ACTIVE', room_id: roomId, story_id: 14 }]
          : []));
      } else if (request.url === '/message_channel/' && request.method === 'POST') {
        storyChannelCreated = true;
        response.end(JSON.stringify({ id: storyChannelId }));
      } else response.end(JSON.stringify({ ok: true }));
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/provision-external-story`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: upstream,
        email: 'operator@example.test',
        password: 'setup-only',
        roomName: 'Public H3',
        evdId,
        storyType: 'WHISPERS',
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      roomId,
      roomShortlink: 'public-h3',
      storyId: 14,
      storyMessageChannelId: storyChannelId,
      roomMainMessageChannelId: roomChannelId,
    });
    expect(calls.find((call) => call.path === '/story/')?.body).toEqual({ room_id: roomId, active: false });
    expect(calls.find((call) => call.path === '/message_channel/' && call.method === 'POST')?.body).toEqual({
      name: 'External audience',
      state: 'ACTIVE',
      story_id: 14,
      room_id: roomId,
    });
    expect(calls.slice(1).every((call) => call.authorization === 'Bearer fresh-session')).toBe(true);
  });

  it('forwards external playback state without exposing the service token in the URL', async () => {
    let authorization = '';
    let upstreamBody: unknown = null;
    const upstream = await listen(createServer(async (request, response) => {
      authorization = String(request.headers.authorization ?? '');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ completion_frontier: 4 }));
    }));
    const proxy = await proxyServer();
    const state = {
      update_id: '570a320b-89d9-4aea-ada3-e8c8b9768fe4',
      played_through_sequence: 4,
      ready_video_seconds: 10,
      generating_video_seconds: 15,
      generation_latency_p90_ms: 20_000,
      desired_runway_seconds: 30,
    };
    const response = await fetch(`${proxy}/api/narrative/external-playback-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: upstream,
        roomId: 'room-1',
        token: 'session-token',
        state,
      }),
    });

    expect(response.status).toBe(200);
    expect(authorization).toBe('Bearer session-token');
    expect(upstreamBody).toEqual(state);
  });

  it('absorbs external playback startup conflicts until the room story is ready', async () => {
    let requestCount = 0;
    const upstream = await listen(createServer((_request, response) => {
      requestCount += 1;
      if (requestCount < 3) {
        response.writeHead(409, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ detail: 'Room has no active story' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ completion_frontier: -1 }));
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/external-playback-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: upstream,
        roomId: 'room-1',
        token: 'session-token',
        state: {
          update_id: '570a320b-89d9-4aea-ada3-e8c8b9768fe4',
          played_through_sequence: -1,
          ready_video_seconds: 0,
          generating_video_seconds: 0,
          generation_latency_p90_ms: null,
          desired_runway_seconds: 30,
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(requestCount).toBe(3);
  });

  it('does not retry canonical external playback conflicts', async () => {
    let requestCount = 0;
    const upstream = await listen(createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        detail: 'played_through_sequence 2 is behind completion frontier 3',
      }));
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/external-playback-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: upstream,
        roomId: 'room-1',
        token: 'session-token',
        state: {
          update_id: '570a320b-89d9-4aea-ada3-e8c8b9768fe4',
          played_through_sequence: 2,
          ready_video_seconds: 10,
          generating_video_seconds: 15,
          generation_latency_p90_ms: 20_000,
          desired_runway_seconds: 30,
        },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      detail: 'played_through_sequence 2 is behind completion frontier 3',
    });
    expect(requestCount).toBe(1);
  });

  it('rejects a renderer-only episode label before creating a room', async () => {
    let upstreamCalls = 0;
    const upstream = await listen(createServer((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(500).end();
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/start-show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: upstream,
        token: 'session-token',
        roomName: 'H3 Show',
        evdId: 'episode-0',
        storyType: 'WHISPERS',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'EVD ID must be a UUID from Narrative Engine, not a local episode label.',
    });
    expect(upstreamCalls).toBe(0);
  });

  it('cancels the active story before leaving a renderer-created room', async () => {
    const calls: Array<{ method: string; path: string; body: unknown; authorization: string }> = [];
    const upstream = await listen(createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body: rawBody ? JSON.parse(rawBody) as unknown : null,
        authorization: request.headers.authorization ?? '',
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/stop-show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: upstream,
        shortlink: 'h3 show',
        token: 'session-token',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/story/cancel?room_shortlink=h3%20show',
        body: null,
        authorization: 'Bearer session-token',
      },
      {
        method: 'POST',
        path: '/room/leave',
        body: { shortlink: 'h3 show' },
        authorization: 'Bearer session-token',
      },
    ]);
  });

  it('logs in only when stopping without a supplied setup token', async () => {
    const calls: Array<{ method: string; path: string; body: unknown; authorization: string }> = [];
    const upstream = await listen(createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body: rawBody ? JSON.parse(rawBody) as unknown : null,
        authorization: request.headers.authorization ?? '',
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(
        request.url === '/auth/login' ? { session_token: 'fresh-stop-session' } : { ok: true },
      ));
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/stop-show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: upstream,
        shortlink: 'STOP42',
        email: 'developer@example.com',
        password: 'setup-password',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/auth/login',
        body: { email: 'developer@example.com', password: 'setup-password' },
        authorization: '',
      },
      {
        method: 'POST',
        path: '/story/cancel?room_shortlink=STOP42',
        body: null,
        authorization: 'Bearer fresh-stop-session',
      },
      {
        method: 'POST',
        path: '/room/leave',
        body: { shortlink: 'STOP42' },
        authorization: 'Bearer fresh-stop-session',
      },
    ]);
  });

  it('does not leave a room when Narrative Engine rejects story cancellation', async () => {
    const paths: string[] = [];
    const upstream = await listen(createServer((request, response) => {
      paths.push(request.url ?? '');
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ detail: 'Failed to cancel story' }));
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/stop-show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: upstream, shortlink: 'h3-show', token: 'session-token' }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ detail: 'Failed to cancel story' });
    expect(paths).toEqual(['/story/cancel?room_shortlink=h3-show']);
  });

  it('leaves an active room when its story has already stopped', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const upstream = await listen(createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body: rawBody ? JSON.parse(rawBody) as unknown : null,
      });
      response.writeHead(request.url?.startsWith('/story/cancel') ? 400 : 200, {
        'Content-Type': 'application/json',
      });
      response.end(JSON.stringify(
        request.url?.startsWith('/story/cancel')
          ? { detail: 'No active story found' }
          : { ok: true },
      ));
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/stop-show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: upstream, shortlink: 'TFSTY0', token: 'session-token' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true });
    expect(calls).toEqual([
      { method: 'POST', path: '/story/cancel?room_shortlink=TFSTY0', body: null },
      { method: 'POST', path: '/room/leave', body: { shortlink: 'TFSTY0' } },
    ]);
  });

  it('loads visible draft and published EVDs from Narrative Authoring', async () => {
    const calls: Array<{ path: string; authorization: string }> = [];
    const upstream = await listen(createServer((request, response) => {
      calls.push({
        path: request.url ?? '',
        authorization: request.headers.authorization ?? '',
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url === '/admin/cvds') {
        response.end(JSON.stringify([
          { id: 'cvd-whispers', name: 'Whispers Show', story_type: 'WHISPERS' },
          { id: 'cvd-creator', name: 'Creator Show', story_type: 'CREATOR' },
        ]));
        return;
      }
      response.end(JSON.stringify([
        {
          id: 'c7dfcb7c-5908-48bc-851c-f39f67a04ac4',
          cvd_id: 'cvd-creator',
          name: 'Draft pilot',
          episode_number: 1,
          is_active: true,
          is_published: false,
        },
        {
          id: '55a03fb0-3c2e-49cd-8eca-70441289678d',
          cvd_id: 'cvd-creator',
          name: 'Published follow-up',
          episode_number: 2,
          is_active: false,
          is_published: true,
        },
      ]));
    }));
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/available-evds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: upstream,
        token: 'session-token',
        storyType: 'CREATOR',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        id: 'c7dfcb7c-5908-48bc-851c-f39f67a04ac4',
        cvd_id: 'cvd-creator',
        cvd_name: 'Creator Show',
        name: 'Draft pilot',
        episode_number: 1,
        is_active: true,
        is_published: false,
      },
      {
        id: '55a03fb0-3c2e-49cd-8eca-70441289678d',
        cvd_id: 'cvd-creator',
        cvd_name: 'Creator Show',
        name: 'Published follow-up',
        episode_number: 2,
        is_active: false,
        is_published: true,
      },
    ]);
    expect(calls).toEqual([
      { path: '/admin/cvds', authorization: 'Bearer session-token' },
      { path: '/admin/cvds/cvd-creator/evds', authorization: 'Bearer session-token' },
    ]);
  });

  it('streams DSS events through the renderer origin and preserves replay parameters', async () => {
    let upstreamUrl = '';
    const upstream = await listen(createServer((request, response) => {
      upstreamUrl = request.url ?? '';
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('event: connected\ndata: {"ok":true}\n\nevent: dss\ndata: {"sequence":7}\n\n');
    }));
    const proxy = await proxyServer();
    const query = new URLSearchParams({
      base_url: upstream,
      shortlink: 'cobalt-fox',
      token: 'token',
      after_sequence: '-1',
      live_only: 'false',
    });
    const response = await fetch(`${proxy}/api/narrative/dss-events?${query}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toContain('event: dss');
    expect(upstreamUrl).toBe('/dss-events?shortlink=cobalt-fox&token=token&after_sequence=-1&live_only=false');
  });

  it('absorbs the active-story startup conflict and connects once DSS is ready', async () => {
    let requestCount = 0;
    const upstream = await listen(createServer((_request, response) => {
      requestCount += 1;
      if (requestCount < 3) {
        response.writeHead(409, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ detail: 'Room does not have an active story' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('event: connected\ndata: {"episode_id":4}\n\nevent: dss\ndata: {"sequence":1}\n\n');
    }));
    const proxy = await proxyServer();
    const query = new URLSearchParams({
      base_url: upstream,
      shortlink: 'starting-room',
      token: 'token',
    });

    const response = await fetch(`${proxy}/api/narrative/dss-events?${query}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('event: dss');
    expect(requestCount).toBe(3);
  });

  it('rejects non-http upstream URLs', async () => {
    const proxy = await proxyServer();
    const response = await fetch(`${proxy}/api/narrative/room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'file:///etc/passwd', shortlink: 'room', token: 'token' }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'service base URL must use http or https' });
  });
});
