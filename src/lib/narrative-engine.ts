import type {
  ChatMessage,
  DssBrowserEvent,
  MessageChannel,
  NarrativeRoom,
  AvailableEvd,
  RendererSettings,
  StartedShowRoom,
  ExternalRendererPlaybackState,
  ExternalRendererPlaybackStateResult,
} from './types';

function trimUrl(value: string): string {
  return value.trim().replace(/\/$/, '');
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { detail?: unknown; error?: unknown };
      const serviceDetail = body.detail ?? body.error;
      if (serviceDetail) detail = typeof serviceDetail === 'string' ? serviceDetail : JSON.stringify(serviceDetail);
    } catch {
      // Preserve the status text when the service did not return JSON.
    }
    throw new Error(`${response.status}: ${detail}`);
  }
  return (await response.json()) as T;
}

export function pickActiveMessageChannel(room: NarrativeRoom): MessageChannel | null {
  const active = (room.message_channels ?? [])
    .filter((channel) => channel.state === 'ACTIVE')
    .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''));
  return (
    active.find((channel) => channel.story_id === room.active_story_id) ??
    active[0] ??
    room.message_channels?.[0] ??
    null
  );
}

export async function joinAndReadRoom(settings: RendererSettings): Promise<NarrativeRoom> {
  const response = await fetch('/api/narrative/room', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: trimUrl(settings.narrativeEngineUrl),
      shortlink: settings.roomShortlink,
      token: settings.sessionToken,
    }),
  });
  return readResponse<NarrativeRoom>(response);
}

export async function createAndStartShow(settings: RendererSettings): Promise<StartedShowRoom> {
  const response = await fetch('/api/narrative/start-show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: trimUrl(settings.narrativeEngineUrl),
      token: settings.sessionToken,
      roomName: settings.roomName,
      evdId: settings.evdId,
      storyType: settings.storyType,
    }),
  });
  return readResponse<StartedShowRoom>(response);
}

export async function stopStartedShow(settings: RendererSettings): Promise<void> {
  const response = await fetch('/api/narrative/stop-show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: trimUrl(settings.narrativeEngineUrl),
      shortlink: settings.roomShortlink,
      token: settings.sessionToken,
    }),
  });
  await readResponse<{ stopped: boolean }>(response);
}

export async function reportExternalPlaybackState(
  settings: RendererSettings,
  roomId: string,
  state: ExternalRendererPlaybackState,
): Promise<ExternalRendererPlaybackStateResult> {
  const response = await fetch('/api/narrative/external-playback-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: trimUrl(settings.narrativeEngineUrl),
      roomId,
      token: settings.sessionToken,
      state,
    }),
  });
  return readResponse<ExternalRendererPlaybackStateResult>(response);
}

export async function listAvailableEvds(settings: RendererSettings): Promise<AvailableEvd[]> {
  const response = await fetch('/api/narrative/available-evds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: trimUrl(settings.narrativeAuthoringUrl),
      token: settings.sessionToken,
      storyType: settings.storyType,
    }),
  });
  return readResponse<AvailableEvd[]>(response);
}

export function openDssEvents(
  settings: RendererSettings,
  onEvent: (event: DssBrowserEvent) => void,
  onState: (state: 'connected' | 'error') => void,
): EventSource {
  const query = new URLSearchParams({
    base_url: trimUrl(settings.realtimeGatewayUrl),
    shortlink: settings.roomShortlink,
    token: settings.sessionToken,
    after_sequence: '-1',
    live_only: settings.setupMode === 'join' ? 'true' : 'false',
  });
  const source = new EventSource(`/api/narrative/dss-events?${query}`);
  source.addEventListener('connected', () => onState('connected'));
  source.addEventListener('dss', (raw) => {
    try {
      onEvent(JSON.parse((raw as MessageEvent<string>).data) as DssBrowserEvent);
    } catch {
      onState('error');
    }
  });
  source.onerror = () => onState('error');
  return source;
}

export interface ChatConnection {
  socket: WebSocket;
  sendMessage: (content: string) => boolean;
}

export function openChat(
  settings: RendererSettings,
  channelId: string,
  onMessages: (messages: ChatMessage[]) => void,
  onState: (state: 'connected' | 'error' | 'closed') => void,
): ChatConnection {
  const base = trimUrl(settings.chatBackendUrl).replace(/^http/, 'ws');
  const query = new URLSearchParams({ message_channel_id: channelId, token: settings.sessionToken });
  const socket = new WebSocket(`${base}/ws?${query}`);
  socket.onopen = () => onState('connected');
  socket.onerror = () => onState('error');
  socket.onclose = () => onState('closed');
  socket.onmessage = (raw) => {
    try {
      const payload = JSON.parse(raw.data as string) as {
        messages?: ChatMessage[];
        message?: ChatMessage;
      };
      if (Array.isArray(payload.messages)) onMessages(payload.messages);
      if (payload.message) onMessages([payload.message]);
    } catch {
      // The chat service can broadcast event shapes unrelated to messages.
    }
  };
  return {
    socket,
    sendMessage: (content) => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ update_type: 'message', content: content.trim() }));
      return true;
    },
  };
}
