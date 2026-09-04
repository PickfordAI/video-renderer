import type { IncomingMessage, ServerResponse } from 'node:http';

const maxProxyRequestBytes = 32_000;
const dssStartupRetryDelayMs = 100;
const dssStartupRetryTimeoutMs = 10_000;
const externalPlaybackStartupRetryDelayMs = 100;
const externalPlaybackStartupRetryTimeoutMs = 10_000;
const externalPlaybackStartupConflicts = new Set([
  'Room has no active story',
  'Room is not configured for an external renderer',
  'Story is not using external renderer playback',
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxProxyRequestBytes) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function serviceBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('service base URL is required');
  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('service base URL must use http or https');
  }
  if (parsed.username || parsed.password) throw new Error('service base URL cannot contain credentials');
  return value.trim().replace(/\/+$/, '');
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function objects(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.filter((item): item is Record<string, unknown> => (
    Boolean(item) && typeof item === 'object' && !Array.isArray(item)
  ));
}

async function forwardResponse(upstream: Response, response: ServerResponse): Promise<void> {
  const body = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function requireUpstreamJson(
  upstream: Response,
  response: ServerResponse,
): Promise<Record<string, unknown> | null> {
  if (!upstream.ok) {
    await forwardResponse(upstream, response);
    return null;
  }
  const value = (await upstream.json()) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Narrative Engine returned an invalid JSON object');
  }
  return value as Record<string, unknown>;
}

function narrativeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function setupToken(
  body: Record<string, unknown>,
  baseUrl: string,
  response: ServerResponse,
): Promise<string | null> {
  const supplied = typeof body.token === 'string' ? body.token.trim() : '';
  if (supplied) return supplied;
  const email = requiredString(body.email, 'setup account email');
  const password = requiredString(body.password, 'setup account password');
  const login = await requireUpstreamJson(await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }), response);
  return login ? requiredString(login.session_token, 'login session token') : null;
}

async function proxyRoom(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await readJson(request);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('request body must be an object');
  const body = raw as Record<string, unknown>;
  const baseUrl = serviceBaseUrl(body.baseUrl);
  const shortlink = requiredString(body.shortlink, 'room code');
  const token = requiredString(body.token, 'session token');
  const headers = narrativeHeaders(token);
  const joinResponse = await fetch(`${baseUrl}/room/join`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ shortlink }),
  });
  if (joinResponse.ok) {
    await forwardResponse(joinResponse, response);
    return;
  }
  if (joinResponse.status !== 409) {
    await forwardResponse(joinResponse, response);
    return;
  }
  await joinResponse.body?.cancel();
  const roomResponse = await fetch(
    `${baseUrl}/room/?shortlink=${encodeURIComponent(shortlink)}&include_most_recent_story=true`,
    { headers },
  );
  await forwardResponse(roomResponse, response);
}

async function proxyStartShow(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await readJson(request);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('request body must be an object');
  const body = raw as Record<string, unknown>;
  const baseUrl = serviceBaseUrl(body.baseUrl);
  const token = requiredString(body.token, 'session token');
  const roomName = requiredString(body.roomName, 'room name');
  const evdId = requiredString(body.evdId, 'Narrative Engine EVD ID');
  if (!uuidPattern.test(evdId)) {
    sendJson(response, 400, { error: 'EVD ID must be a UUID from Narrative Engine, not a local episode label.' });
    return;
  }
  const storyType = body.storyType === 'CREATOR' ? 'CREATOR' : 'WHISPERS';
  const headers = narrativeHeaders(token);
  const created = await requireUpstreamJson(await fetch(`${baseUrl}/room/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: roomName, visibility: 'PRIVATE', state: 'ACTIVE', redundant_renderer_count: 1, story_type: storyType }),
  }), response);
  if (!created) return;
  const roomId = requiredString(created.id, 'created room id');
  const shortlink = requiredString(created.shortlink, 'created room code');
  if (!await requireUpstreamJson(await fetch(`${baseUrl}/room/join`, {
    method: 'POST', headers, body: JSON.stringify({ shortlink }),
  }), response)) return;
  const playback = await fetch(`${baseUrl}/room/playback-mode`, {
    method: 'PATCH', headers, body: JSON.stringify({ room_id: roomId, mode: 'video' }),
  });
  if (!playback.ok) { await forwardResponse(playback, response); return; }
  await playback.body?.cancel();
  const started = await requireUpstreamJson(await fetch(`${baseUrl}/show/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ evd_id: evdId, room_shortlink: shortlink, character_ids: [], config: {} }),
  }), response);
  if (!started) return;
  const room = await requireUpstreamJson(await fetch(
    `${baseUrl}/room/?shortlink=${encodeURIComponent(shortlink)}&include_most_recent_story=true`,
    { headers },
  ), response);
  if (!room) return;
  sendJson(response, 200, { room, show: started });
}

async function proxyPrepareShow(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await readJson(request);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('request body must be an object');
  const body = raw as Record<string, unknown>;
  const baseUrl = serviceBaseUrl(body.baseUrl);
  const token = requiredString(body.token, 'session token');
  const roomName = requiredString(body.roomName, 'room name');
  const evdId = requiredString(body.evdId, 'Narrative Engine EVD ID');
  if (!uuidPattern.test(evdId)) {
    sendJson(response, 400, { error: 'EVD ID must be a UUID from Narrative Engine, not a local episode label.' });
    return;
  }
  const storyType = body.storyType === 'CREATOR' ? 'CREATOR' : 'WHISPERS';
  const headers = narrativeHeaders(token);
  let storyPremise: string | null = null;
  if (storyType === 'CREATOR') {
    const authoringBaseUrl = serviceBaseUrl(body.authoringBaseUrl);
    const evd = await requireUpstreamJson(await fetch(
      `${authoringBaseUrl}/admin/evds/${encodeURIComponent(evdId)}`,
      { headers },
    ), response);
    if (!evd) return;
    const cvdId = requiredString(evd.cvd_id, 'Creator CVD id');
    const document = await requireUpstreamJson(await fetch(
      `${authoringBaseUrl}/admin/cvds/${encodeURIComponent(cvdId)}/document`,
      { headers },
    ), response);
    if (!document) return;
    const documentBody = document.document;
    if (!documentBody || typeof documentBody !== 'object' || Array.isArray(documentBody)) {
      throw new Error('Creator CVD document is invalid');
    }
    const metadata = (documentBody as Record<string, unknown>).metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('Creator CVD metadata is invalid');
    }
    storyPremise = requiredString((metadata as Record<string, unknown>).premise, 'Creator story premise');
  }

  const created = await requireUpstreamJson(await fetch(`${baseUrl}/room/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: roomName,
      visibility: 'PRIVATE',
      state: 'ACTIVE',
      redundant_renderer_count: 1,
      story_type: storyType,
    }),
  }), response);
  if (!created) return;
  const roomId = requiredString(created.id, 'created room id');
  const shortlink = requiredString(created.shortlink, 'created room code');

  const joined = await requireUpstreamJson(await fetch(`${baseUrl}/room/join`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ shortlink }),
  }), response);
  if (!joined) return;

  const playback = await fetch(`${baseUrl}/room/playback-mode`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ room_id: roomId, mode: 'video' }),
  });
  if (!playback.ok) {
    await forwardResponse(playback, response);
    return;
  }
  await playback.body?.cancel();

  const story = await requireUpstreamJson(await fetch(`${baseUrl}/story/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      room_id: roomId,
      evd_id: evdId,
      active: false,
    }),
  }), response);
  if (!story) return;
  const storyId = Number(story.id);
  if (!Number.isInteger(storyId) || storyId <= 0) throw new Error('created story id is invalid');

  const channelsResponse = await fetch(`${baseUrl}/message_channel/?story_id=${storyId}`, { headers });
  if (!channelsResponse.ok) {
    await forwardResponse(channelsResponse, response);
    return;
  }
  const existingChannels = await channelsResponse.json() as unknown;
  if (!Array.isArray(existingChannels)) throw new Error('story message-channel response is invalid');
  let storyChannel = existingChannels.find((value) => (
    value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).state === 'ACTIVE'
  )) as Record<string, unknown> | undefined;
  if (!storyChannel) {
    storyChannel = await requireUpstreamJson(await fetch(`${baseUrl}/message_channel/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `${roomName} story`,
        story_id: storyId,
        room_id: roomId,
        state: 'ACTIVE',
      }),
    }), response) ?? undefined;
  }
  if (!storyChannel) return;
  const storyMessageChannelId = requiredString(storyChannel.id, 'story message-channel id');
  const storyConfig = {
    base_structure: storyType,
    evd_id: evdId,
    character_ids: [],
    message_channel_ids: [storyMessageChannelId],
    ...(storyPremise ? { story_premise: storyPremise } : {}),
  };
  sendJson(response, 200, {
    room: {
      ...created,
      active_story_id: storyId,
      message_channels: [storyChannel],
    },
    storyId,
    storyMessageChannelId,
    storyConfig,
  });
}

async function proxyProvisionExternalStory(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await readJson(request);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('request body must be an object');
  const body = raw as Record<string, unknown>;
  const baseUrl = serviceBaseUrl(body.baseUrl);
  const token = await setupToken(body, baseUrl, response);
  if (!token) return;
  const roomName = requiredString(body.roomName, 'room name');
  const evdId = requiredString(body.evdId, 'Narrative Engine EVD ID');
  if (!uuidPattern.test(evdId)) {
    sendJson(response, 400, { error: 'EVD ID must be a UUID from Narrative Engine.' });
    return;
  }
  const storyType = body.storyType === 'CREATOR' ? 'CREATOR' : 'WHISPERS';
  const headers = narrativeHeaders(token);

  const created = await requireUpstreamJson(await fetch(`${baseUrl}/room/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: roomName,
      visibility: 'PRIVATE',
      state: 'ACTIVE',
      redundant_renderer_count: 1,
      story_type: storyType,
    }),
  }), response);
  if (!created) return;
  const roomId = requiredString(created.id, 'created room id');
  const shortlink = requiredString(created.shortlink, 'created room code');

  const joined = await fetch(`${baseUrl}/room/join`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ shortlink }),
  });
  if (!joined.ok) {
    await forwardResponse(joined, response);
    return;
  }
  await joined.body?.cancel();

  const story = await requireUpstreamJson(await fetch(`${baseUrl}/story/`, {
    method: 'POST',
    headers,
    // The public renderer start owns the EVD-bearing story configuration.
    // Keep the pre-created row deliberately bare and inactive so orchestration
    // cannot mistake it for an already-running legacy show.
    body: JSON.stringify({ room_id: roomId, active: false }),
  }), response);
  if (!story) return;
  const storyId = requiredPositiveInteger(story.id, 'created story id');

  const readChannels = async (scope: 'room_id' | 'story_id', id: string | number) => {
    const upstream = await fetch(`${baseUrl}/message_channel/?${scope}=${encodeURIComponent(String(id))}`, { headers });
    if (!upstream.ok) {
      await forwardResponse(upstream, response);
      return null;
    }
    return objects(await upstream.json(), `${scope} message channels`);
  };

  const roomChannels = await readChannels('room_id', roomId);
  if (!roomChannels) return;
  const activeRoomChannels = roomChannels.filter((channel) => channel.state === 'ACTIVE' && channel.room_id === roomId);
  if (activeRoomChannels.length !== 1) throw new Error('room must have exactly one active main message channel');
  const roomMainMessageChannelId = requiredString(activeRoomChannels[0].id, 'room main message channel id');

  let storyChannels = await readChannels('story_id', storyId);
  if (!storyChannels) return;
  if (storyChannels.length === 0) {
    const createdChannel = await fetch(`${baseUrl}/message_channel/`, {
      method: 'POST',
      headers,
      // External-renderer authorization binds all three identities together:
      // the story, its room, and this dedicated audience channel. The public
      // API accepts both scopes on one channel; omitting room_id creates a
      // story-only channel that can never pass the renderer-platform check.
      body: JSON.stringify({
        name: 'External audience',
        state: 'ACTIVE',
        story_id: storyId,
        room_id: roomId,
      }),
    });
    if (!createdChannel.ok) {
      await forwardResponse(createdChannel, response);
      return;
    }
    await createdChannel.body?.cancel();
    storyChannels = await readChannels('story_id', storyId);
    if (!storyChannels) return;
  }
  const activeStoryChannels = storyChannels.filter((channel) => (
    channel.state === 'ACTIVE'
    && channel.story_id === storyId
    && channel.room_id === roomId
  ));
  if (activeStoryChannels.length !== 1) throw new Error('story must have exactly one active story-scoped message channel');
  const storyMessageChannelId = requiredString(activeStoryChannels[0].id, 'story message channel id');
  if (storyMessageChannelId === roomMainMessageChannelId) {
    throw new Error('story-scoped and room-main message channels must be distinct');
  }

  sendJson(response, 201, {
    roomId,
    roomShortlink: shortlink,
    storyId,
    storyMessageChannelId,
    roomMainMessageChannelId,
  });
}

async function proxyExternalPlaybackState(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await readJson(request);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('request body must be an object');
  const body = raw as Record<string, unknown>;
  const baseUrl = serviceBaseUrl(body.baseUrl);
  const roomId = requiredString(body.roomId, 'room id');
  const token = requiredString(body.token, 'session token');
  const state = body.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('external playback state is required');
  }
  const upstreamUrl = `${baseUrl}/room/${encodeURIComponent(roomId)}/external-renderer/playback-state`;
  const startupDeadline = Date.now() + externalPlaybackStartupRetryTimeoutMs;
  let upstream: Response;
  while (true) {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: narrativeHeaders(token),
      body: JSON.stringify(state),
    });
    if (upstream.status !== 409 || Date.now() >= startupDeadline) break;
    let detail: unknown;
    try {
      const conflict = await upstream.clone().json() as { detail?: unknown };
      detail = conflict.detail;
    } catch {
      detail = null;
    }
    if (typeof detail !== 'string' || !externalPlaybackStartupConflicts.has(detail)) break;
    await upstream.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, externalPlaybackStartupRetryDelayMs));
  }
  await forwardResponse(upstream, response);
}

async function proxyStopShow(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await readJson(request);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('request body must be an object');
  const body = raw as Record<string, unknown>;
  const baseUrl = serviceBaseUrl(body.baseUrl);
  const shortlink = requiredString(body.shortlink, 'room code');
  const token = await setupToken(body, baseUrl, response);
  if (!token) return;
  const headers = narrativeHeaders(token);

  const cancelled = await fetch(
    `${baseUrl}/story/cancel?room_shortlink=${encodeURIComponent(shortlink)}`,
    { method: 'POST', headers },
  );
  if (!cancelled.ok) {
    if (cancelled.status !== 400) {
      await forwardResponse(cancelled, response);
      return;
    }
    const cancellationBody = await cancelled.text();
    let cancellationDetail = '';
    try {
      const parsed = JSON.parse(cancellationBody) as { detail?: unknown };
      cancellationDetail = typeof parsed.detail === 'string' ? parsed.detail : '';
    } catch {
      cancellationDetail = '';
    }
    if (cancellationDetail !== 'No active story found') {
      response.writeHead(cancelled.status, { 'Content-Type': cancelled.headers.get('content-type') ?? 'application/json' });
      response.end(cancellationBody);
      return;
    }
  } else {
    await cancelled.body?.cancel();
  }

  const left = await fetch(`${baseUrl}/room/leave`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ shortlink }),
  });
  if (!left.ok) {
    await forwardResponse(left, response);
    return;
  }
  await left.body?.cancel();
  sendJson(response, 200, { stopped: true });
}

async function proxyAvailableEvds(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await readJson(request);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('request body must be an object');
  const body = raw as Record<string, unknown>;
  const baseUrl = serviceBaseUrl(body.baseUrl);
  const token = requiredString(body.token, 'session token');
  const storyType = body.storyType === 'CREATOR' ? 'CREATOR' : 'WHISPERS';
  const headers = narrativeHeaders(token);
  const cvdResponse = await fetch(`${baseUrl}/admin/cvds`, { headers });
  if (!cvdResponse.ok) {
    await forwardResponse(cvdResponse, response);
    return;
  }
  const cvdValue = (await cvdResponse.json()) as unknown;
  if (!Array.isArray(cvdValue)) throw new Error('Narrative Authoring returned an invalid CVD list');
  const cvds = cvdValue.filter((value): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value) && value.story_type === storyType
  ));
  const available: Record<string, unknown>[] = [];
  for (const cvd of cvds) {
    const cvdId = requiredString(cvd.id, 'CVD id');
    const cvdName = requiredString(cvd.name, 'CVD name');
    const evdResponse = await fetch(`${baseUrl}/admin/cvds/${encodeURIComponent(cvdId)}/evds`, { headers });
    if (!evdResponse.ok) {
      await forwardResponse(evdResponse, response);
      return;
    }
    const evdValue = (await evdResponse.json()) as unknown;
    if (!Array.isArray(evdValue)) throw new Error('Narrative Authoring returned an invalid EVD list');
    for (const value of evdValue) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      available.push({ ...(value as Record<string, unknown>), cvd_name: cvdName });
    }
  }
  available.sort((left, right) => {
    const showOrder = String(left.cvd_name).localeCompare(String(right.cvd_name));
    if (showOrder !== 0) return showOrder;
    return Number(left.episode_number) - Number(right.episode_number);
  });
  sendJson(response, 200, available);
}

async function proxyDssEvents(request: IncomingMessage, response: ServerResponse, requestUrl: URL): Promise<void> {
  const baseUrl = serviceBaseUrl(requestUrl.searchParams.get('base_url'));
  const shortlink = requiredString(requestUrl.searchParams.get('shortlink'), 'room code');
  const token = requiredString(requestUrl.searchParams.get('token'), 'session token');
  const upstreamUrl = new URL(`${baseUrl}/dss-events`);
  upstreamUrl.search = new URLSearchParams({
    shortlink,
    token,
    after_sequence: requestUrl.searchParams.get('after_sequence') ?? '-1',
    live_only: requestUrl.searchParams.get('live_only') ?? 'false',
  }).toString();

  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once('close', abort);
  try {
    const startupDeadline = Date.now() + dssStartupRetryTimeoutMs;
    let upstream: Response;
    while (true) {
      upstream = await fetch(upstreamUrl, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (upstream.status !== 409 || Date.now() >= startupDeadline) break;
      await upstream.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, dssStartupRetryDelayMs));
    }
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text();
      sendJson(response, upstream.status, { error: detail || upstream.statusText });
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const reader = upstream.body.getReader();
    while (!response.destroyed) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(Buffer.from(value));
    }
    if (!response.destroyed) response.end();
  } finally {
    response.off('close', abort);
    controller.abort();
  }
}

export async function handleNarrativeEngineApi(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const requestUrl = new URL(request.url ?? '/', 'http://renderer.local');
  const isRoom = requestUrl.pathname === '/api/narrative/room';
  const isStartShow = requestUrl.pathname === '/api/narrative/start-show';
  const isProvisionExternalStory = requestUrl.pathname === '/api/narrative/provision-external-story';
  const isPrepareShow = requestUrl.pathname === '/api/narrative/prepare-show';
  const isStopShow = requestUrl.pathname === '/api/narrative/stop-show';
  const isExternalPlayback = requestUrl.pathname === '/api/narrative/external-playback-state';
  const isAvailableEvds = requestUrl.pathname === '/api/narrative/available-evds';
  const isDss = requestUrl.pathname === '/api/narrative/dss-events';
  if (!isRoom && !isStartShow && !isPrepareShow && !isProvisionExternalStory && !isStopShow && !isExternalPlayback && !isAvailableEvds && !isDss) return false;

  try {
    if (isRoom || isStartShow || isPrepareShow || isProvisionExternalStory || isStopShow || isExternalPlayback || isAvailableEvds) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method not allowed' });
      } else if (isStartShow) {
        await proxyStartShow(request, response);
      } else if (isProvisionExternalStory) {
        await proxyProvisionExternalStory(request, response);
      } else if (isPrepareShow) {
        await proxyPrepareShow(request, response);
      } else if (isStopShow) {
        await proxyStopShow(request, response);
      } else if (isExternalPlayback) {
        await proxyExternalPlaybackState(request, response);
      } else if (isAvailableEvds) {
        await proxyAvailableEvds(request, response);
      } else {
        await proxyRoom(request, response);
      }
    } else if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method not allowed' });
    } else {
      await proxyDssEvents(request, response, requestUrl);
    }
  } catch (error) {
    if (!response.headersSent) {
      const message = error instanceof Error ? error.message : 'Narrative Engine proxy failed';
      sendJson(response, 502, { error: message });
    } else if (!response.destroyed) {
      response.end();
    }
  }
  return true;
}
