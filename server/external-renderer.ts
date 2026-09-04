import { createHash, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import WebSocket from 'ws';

import { generateVideo } from './fal.js';
import type { PlayoutManager, PlayoutSession } from './playout.js';

type JsonObject = Record<string, unknown>;

interface ExternalRendererRunConfig {
  baseUrl: string;
  chatBaseUrl: string;
  rendererId: string;
  credentialId: string;
  clientSecret: string;
  rendererVersion: string;
  storyId: number;
  roomId: string;
  storyMessageChannelId: string;
  roomMainMessageChannelId: string;
  storyConfig: JsonObject;
  audienceMessages: number;
  audienceDurationSeconds: number;
  resolution: '480P' | '768P';
  clipDurationSeconds: number;
  resumeExistingStory: boolean;
  enableRendererRelay: boolean;
}

export interface ExternalRendererRunStatus {
  runId: string;
  state: 'connecting' | 'running' | 'stopped' | 'failed';
  rendererId: string;
  rendererVersion: string;
  storyId: number;
  roomId: string;
  storyMessageChannelId: string;
  roomMainMessageChannelId: string;
  sessionId: string | null;
  sessionEpoch: number | null;
  startedAt: string;
  storyStartAt: string | null;
  storyStartStatus: number | null;
  firstAssignmentAt: string | null;
  firstDssAcknowledgedAt: string | null;
  dssSequences: number[];
  dssCommandsRendered: number;
  clipsRendered: number;
  audienceDirectSent: number;
  audienceDirectAccepted: number;
  audienceRelaySent: number;
  audienceRelayAccepted: number;
  audienceFanoutDeliveries: number;
  audienceDuplicateVerified: boolean;
  audiencePrincipalsDistinct: boolean;
  hlsUrl: string | null;
  lastHeartbeatAt: string | null;
  failures: string[];
}

interface DssGroup {
  id: string;
  commands: JsonObject[];
}

interface DssFrame {
  raw: JsonObject;
  sequence: number;
  assignmentId: string;
  assignmentGeneration: number;
  storyBlockId: string;
  groups: DssGroup[];
}

interface PlannedClip {
  groupId: string;
  storyBlockId: string;
  prompt: string;
  durationSeconds: number;
}

interface AudienceSocket {
  socket: WebSocket;
  principalId: string;
  messages: AsyncJsonQueue;
  acknowledgements: Map<string, (value: JsonObject) => void>;
}

const PROTOCOL_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const MAX_FAILURES = 50;
const COMMAND_GROUP_PROGRESS_MESSAGE_ID = 10;
const SCRIPT_STATUS_MESSAGE_ID = 6;
const GROUP_FINISHED_STATUS_ID = 10;

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredUrl(value: unknown, label: string): string {
  const raw = requiredString(value, label).replace(/\/$/, '');
  const parsed = new URL(raw);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain credentials, query, or fragment`);
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error(`${label} must use HTTPS`);
  }
  return raw;
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || (resolved as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return resolved as number;
}

function uuid(value: unknown, label: string): string {
  const raw = requiredString(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new Error(`${label} must be a UUID`);
  }
  return raw;
}

export function parseExternalRendererRunConfig(value: unknown): ExternalRendererRunConfig {
  const body = asObject(value, 'run config');
  const storyConfig = asObject(body.storyConfig, 'storyConfig');
  const rendererId = uuid(body.rendererId, 'rendererId');
  const configuredChannels = storyConfig.message_channel_ids;
  const storyMessageChannelId = uuid(body.storyMessageChannelId, 'storyMessageChannelId');
  if (!Array.isArray(configuredChannels) || configuredChannels.length !== 1 || configuredChannels[0] !== storyMessageChannelId) {
    throw new Error('storyConfig.message_channel_ids must contain only storyMessageChannelId');
  }
  const roomMainMessageChannelId = uuid(body.roomMainMessageChannelId, 'roomMainMessageChannelId');
  if (storyMessageChannelId === roomMainMessageChannelId) throw new Error('story and room-main channels must be distinct');
  const resolution = body.resolution ?? '480P';
  if (resolution !== '480P' && resolution !== '768P') throw new Error('resolution must be 480P or 768P');
  const clipDurationSeconds = positiveInteger(body.clipDurationSeconds, 6, 'clipDurationSeconds');
  if (clipDurationSeconds < 5 || clipDurationSeconds > 15) throw new Error('clipDurationSeconds must be 5-15');
  const rendererVersion = requiredString(body.rendererVersion, 'rendererVersion');
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){3}$/.test(rendererVersion)) {
    throw new Error('rendererVersion must contain exactly four dot-separated components');
  }
  return {
    baseUrl: requiredUrl(body.baseUrl ?? 'https://edge.pickford.ai', 'baseUrl'),
    chatBaseUrl: requiredUrl(body.chatBaseUrl ?? 'https://chat.edge.pickford.ai', 'chatBaseUrl'),
    rendererId,
    credentialId: uuid(body.credentialId, 'credentialId'),
    clientSecret: requiredString(body.clientSecret, 'clientSecret'),
    rendererVersion,
    storyId: positiveInteger(body.storyId, 0, 'storyId'),
    roomId: uuid(body.roomId, 'roomId'),
    storyMessageChannelId,
    roomMainMessageChannelId,
    storyConfig,
    audienceMessages: Math.max(100, positiveInteger(body.audienceMessages, 100, 'audienceMessages')),
    audienceDurationSeconds: positiveInteger(body.audienceDurationSeconds, 180, 'audienceDurationSeconds'),
    resolution,
    clipDurationSeconds,
    resumeExistingStory: body.resumeExistingStory === true,
    enableRendererRelay: body.enableRendererRelay === true,
  };
}

class AsyncJsonQueue {
  private readonly values: JsonObject[] = [];
  private readonly waiters: Array<(value: JsonObject) => void> = [];

  push(value: JsonObject): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  async next(timeoutMs = 60_000): Promise<JsonObject> {
    const value = this.values.shift();
    if (value) return value;
    return await new Promise<JsonObject>((resolve, reject) => {
      const waiter = (item: JsonObject) => {
        clearTimeout(timeout);
        resolve(item);
      };
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('timed out waiting for a WebSocket message'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async matching(predicate: (value: JsonObject) => boolean, timeoutMs = 60_000): Promise<JsonObject> {
    const deadline = Date.now() + timeoutMs;
    const skipped: JsonObject[] = [];
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for a correlated WebSocket message');
      const value = await this.next(remaining);
      if (predicate(value)) {
        skipped.forEach((item) => this.push(item));
        return value;
      }
      skipped.push(value);
    }
  }
}

function openWebSocket(url: string, headers: Record<string, string>): Promise<{ socket: WebSocket; messages: AsyncJsonQueue }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const messages = new AsyncJsonQueue();
    const onError = (error: Error) => reject(error);
    socket.once('error', onError);
    socket.once('open', () => {
      socket.off('error', onError);
      socket.on('message', (data) => {
        try {
          messages.push(asObject(JSON.parse(data.toString()), 'WebSocket frame'));
        } catch {
          socket.close(4400, 'invalid JSON');
        }
      });
      socket.on('close', (code) => messages.push({ type: 'websocket.closed', code }));
      resolve({ socket, messages });
    });
  });
}

function commandName(command: JsonObject): string {
  return String(command.command ?? '').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
}

function commandArgs(command: JsonObject): JsonObject {
  const value = command.args ?? command.content;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function textArg(command: JsonObject, key: string): string | null {
  const value = commandArgs(command)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseDssFrame(raw: JsonObject): DssFrame {
  const script = asObject(raw.script, 'DSS script');
  const sequence = Number(script.sequence ?? raw.sequence);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error('DSS sequence must be a non-negative integer');
  const rawGroups = script.command_groups;
  if (!Array.isArray(rawGroups)) throw new Error('DSS command_groups must be an array');
  const groups = rawGroups.map((value, index) => {
    const group = asObject(value, `DSS group ${index}`);
    const commands = group.commands;
    if (!Array.isArray(commands)) throw new Error(`DSS group ${index} commands must be an array`);
    return {
      id: requiredString(group.id ?? `group-${sequence}-${index}`, `DSS group ${index} id`),
      commands: commands.map((command, commandIndex) => asObject(command, `DSS command ${commandIndex}`)),
    };
  });
  return {
    raw,
    sequence,
    assignmentId: String(raw.assignment_id ?? ''),
    assignmentGeneration: Number(raw.assignment_generation ?? 0),
    storyBlockId: String(raw.story_block_id ?? script.story_block_id ?? `sequence-${sequence}`),
    groups,
  };
}

export function planGroupClips(frame: DssFrame, group: DssGroup, durationSeconds: number): PlannedClip[] {
  const visual: string[] = [];
  const dialogue: string[] = [];
  for (const command of group.commands) {
    const name = commandName(command);
    const compact = name.replace(/\s/g, '');
    const character = textArg(command, 'character') ?? textArg(command, 'name');
    if (compact === 'talk' || compact === 'charactertalk') {
      const line = textArg(command, 'dialogue');
      if (!line) continue;
      const respondent = textArg(command, 'respondent');
      const tone = textArg(command, 'tone');
      const speaker = character ?? 'A character';
      dialogue.push(`${speaker}${tone ? ` (${tone})` : ''} speaks${respondent ? ` to ${respondent}` : ''}: “${line}”`);
      continue;
    }
    if (compact === 'enableset') {
      const setName = textArg(command, 'set');
      if (setName) visual.push(`Setting: ${setName}.`);
    } else if (compact === 'addcharacter' || compact === 'spawncharacter') {
      if (character) visual.push(`${character} is present in the scene.`);
    } else if (compact === 'setemotion') {
      const emotion = textArg(command, 'emotion');
      if (character && emotion) visual.push(`${character}'s expression is ${emotion}.`);
    } else if (compact === 'playanimation') {
      const animation = textArg(command, 'animation');
      if (character && animation) visual.push(`${character} performs ${animation}.`);
    } else if (compact === 'cutscene') {
      continue;
    }
  }
  if (dialogue.length === 0 && visual.length === 0) return [];
  return [{
    groupId: group.id,
    storyBlockId: `${frame.storyBlockId}:${group.id}`,
    durationSeconds,
    prompt: [
      'Cinematic live-action story scene, expressive natural performances, moody practical lighting, shallow depth of field, coherent characters, subtle ambient sound, no titles or captions.',
      ...visual,
      dialogue.length > 0 ? `Play these dialogue beats once, in exact order: ${dialogue.join(' Then ')}` : '',
      `Let the complete command-group moment unfold naturally across the full ${durationSeconds}-second shot. Preserve character identity, dialogue order, and conversational continuity.`,
    ].filter(Boolean).join(' '),
  }];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function send(socket: WebSocket, payload: JsonObject): void {
  if (socket.readyState !== WebSocket.OPEN) throw new Error('renderer WebSocket is not open');
  socket.send(JSON.stringify(payload));
}

export function createCommandProgressEvent(input: {
  streamId: string;
  assignmentId: string;
  assignmentGeneration: number;
  sequence: number;
  groupId: string;
  current: number;
  total: number;
  storyBlockId: string;
  status: 'in_progress' | 'completed';
}): JsonObject {
  return {
    type: 'renderer.event',
    event: 'command_progress',
    id: COMMAND_GROUP_PROGRESS_MESSAGE_ID,
    stream_id: input.streamId,
    assignment_id: input.assignmentId,
    assignment_generation: input.assignmentGeneration,
    sequence: input.sequence,
    status: input.status,
    group_id: input.groupId,
    current: input.current,
    total: input.total,
    story_block_id: input.storyBlockId,
  };
}

export function createGroupFinishedEvent(input: {
  streamId: string;
  assignmentId: string;
  assignmentGeneration: number;
  sequence: number;
  groupId: string;
  storyBlockId: string;
  durationSeconds: number;
}): JsonObject {
  return {
    type: 'renderer.event',
    event: 'completed',
    id: SCRIPT_STATUS_MESSAGE_ID,
    stream_id: input.streamId,
    assignment_id: input.assignmentId,
    assignment_generation: input.assignmentGeneration,
    sequence: input.sequence,
    status: GROUP_FINISHED_STATUS_ID,
    duration: input.durationSeconds,
    dss_id: input.groupId,
    timestamp: Date.now() / 1_000,
    story_block_id: input.storyBlockId,
  };
}

async function jsonResponse(response: Response, label: string, expected: number): Promise<JsonObject> {
  if (response.status !== expected) throw new Error(`${label} failed with HTTP ${response.status}`);
  return asObject(await response.json(), label);
}

async function rendererLogin(config: ExternalRendererRunConfig): Promise<JsonObject> {
  const basic = Buffer.from(`${config.credentialId}:${config.clientSecret}`).toString('base64');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`${config.baseUrl}/api/v1/renderers/login`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        renderer_id: config.rendererId,
        subject: 'client_credential',
        tier: 'renderer-dev',
        environment: 'edge',
      }),
    });
    if (response.status !== 429) return await jsonResponse(response, 'renderer login', 200);
    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '1', 10);
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, retryAfter) * 1_000));
  }
  throw new Error('renderer login remained rate limited after sequential Retry-After waits');
}

function sessionCookie(response: Response): string {
  const values = response.headers.getSetCookie();
  const matching = values.find((value) => value.includes('Path=/api/v1/external-audience'));
  if (!matching) throw new Error('audience exchange returned no scoped session cookie');
  return matching.split(';', 1)[0];
}

async function openAudience(config: ExternalRendererRunConfig, joinLink: string): Promise<AudienceSocket> {
  const handle = new URL(joinLink).pathname.split('/').filter(Boolean).at(-1);
  if (!handle) throw new Error('audience join link contained no opaque handle');
  const exchange = await fetch(`${config.chatBaseUrl}/api/v1/external-audience/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://edge.pickford.ai' },
    body: JSON.stringify({ opaque_handle: handle }),
  });
  const payload = await jsonResponse(exchange, 'audience exchange', 200);
  const session = asObject(payload.session, 'audience session');
  if (session.story_id !== config.storyId || session.message_channel_id !== config.storyMessageChannelId) {
    throw new Error('audience exchange returned mismatched story or channel claims');
  }
  const opened = await openWebSocket(requiredString(payload.websocket_url, 'audience websocket_url'), {
    Cookie: sessionCookie(exchange),
    Origin: 'https://edge.pickford.ai',
  });
  send(opened.socket, { type: 'audience.hello', protocol_version: PROTOCOL_VERSION });
  const welcome = await opened.messages.matching((item) => item.type === 'audience.welcome');
  const welcomedSession = asObject(welcome.session, 'audience welcome session');
  if (welcomedSession.story_id !== config.storyId || welcomedSession.message_channel_id !== config.storyMessageChannelId) {
    throw new Error('audience welcome returned mismatched story or channel claims');
  }
  return {
    socket: opened.socket,
    principalId: requiredString(welcomedSession.principal_id, 'audience principal_id'),
    messages: opened.messages,
    acknowledgements: new Map(),
  };
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.close(1000, 'validation complete');
    setTimeout(() => {
      socket.terminate();
      resolve();
    }, 2_000).unref();
  });
}

class ExternalRendererRun {
  readonly runId = randomUUID();
  readonly status: ExternalRendererRunStatus;
  private socket: WebSocket | null = null;
  private playout: PlayoutSession | null = null;
  private stopped = false;
  private clipPosition = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private audienceTask: Promise<void> | null = null;
  private readonly relayResults = new Map<string, (value: JsonObject) => void>();
  private readonly seenDss = new Set<string>();

  constructor(
    private readonly config: ExternalRendererRunConfig,
    private readonly playoutManager: PlayoutManager,
    private readonly apiKey: string,
  ) {
    this.status = {
      runId: this.runId,
      state: 'connecting',
      rendererId: config.rendererId,
      rendererVersion: config.rendererVersion,
      storyId: config.storyId,
      roomId: config.roomId,
      storyMessageChannelId: config.storyMessageChannelId,
      roomMainMessageChannelId: config.roomMainMessageChannelId,
      sessionId: null,
      sessionEpoch: null,
      startedAt: new Date().toISOString(),
      storyStartAt: null,
      storyStartStatus: null,
      firstAssignmentAt: null,
      firstDssAcknowledgedAt: null,
      dssSequences: [],
      dssCommandsRendered: 0,
      clipsRendered: 0,
      audienceDirectSent: 0,
      audienceDirectAccepted: 0,
      audienceRelaySent: 0,
      audienceRelayAccepted: 0,
      audienceFanoutDeliveries: 0,
      audienceDuplicateVerified: false,
      audiencePrincipalsDistinct: false,
      hlsUrl: null,
      lastHeartbeatAt: null,
      failures: [],
    };
  }

  private fail(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.status.failures.push(detail.slice(0, 500));
    this.status.failures.splice(0, Math.max(0, this.status.failures.length - MAX_FAILURES));
    this.status.state = 'failed';
  }

  private progressEvent(frame: DssFrame, group: DssGroup, current: number, total: number): JsonObject {
    return createCommandProgressEvent({
      streamId: this.config.rendererId,
      assignmentId: frame.assignmentId,
      assignmentGeneration: frame.assignmentGeneration,
      sequence: frame.sequence,
      status: 'in_progress',
      groupId: group.id,
      current,
      total,
      storyBlockId: frame.storyBlockId,
    });
  }

  private completedEvent(frame: DssFrame, group: DssGroup, durationSeconds: number): JsonObject {
    return createGroupFinishedEvent({
      streamId: this.config.rendererId,
      assignmentId: frame.assignmentId,
      assignmentGeneration: frame.assignmentGeneration,
      sequence: frame.sequence,
      groupId: group.id,
      storyBlockId: frame.storyBlockId,
      durationSeconds,
    });
  }

  private async waitForPlayback(position: number): Promise<void> {
    for (;;) {
      if (this.stopped) throw new Error('renderer run stopped');
      const current = this.playout?.status();
      if (current?.state === 'error') throw new Error(current.error ?? 'playout failed');
      if (current && current.playedThroughPosition >= position) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private async renderFrame(frame: DssFrame): Promise<void> {
    const dedupeKey = `${frame.assignmentGeneration}:${frame.sequence}`;
    if (this.seenDss.has(dedupeKey)) return;
    this.seenDss.add(dedupeKey);
    this.status.firstAssignmentAt ??= new Date().toISOString();
    this.status.dssSequences.push(frame.sequence);
    const groupsWithCommands = frame.groups.filter((group) => group.commands.length > 0);
    if (groupsWithCommands.length === 0) {
      frame.groups.forEach((group) => send(this.socket!, this.completedEvent(frame, group, 0)));
      this.status.firstDssAcknowledgedAt ??= new Date().toISOString();
      return;
    }
    groupsWithCommands.forEach((group) => send(this.socket!, this.progressEvent(frame, group, 0, group.commands.length)));
    const planned = frame.groups.flatMap((group) => planGroupClips(frame, group, this.config.clipDurationSeconds));
    const fallbackCommands = groupsWithCommands
      .flatMap((group) => group.commands.map(commandName))
      .filter(Boolean)
      .join(', ');
    const prompt = planned.length > 0
      ? planned.map((clip, index) => `Beat ${index + 1}: ${clip.prompt}`).join(' ')
      : `Cinematic live-action story transition. Apply these ordered renderer commands: ${fallbackCommands}. No titles or captions.`;
    const generated = await generateVideo(
      {
        prompt,
        duration: this.config.clipDurationSeconds,
        resolution: this.config.resolution,
        aspectRatio: '16:9',
      },
      {
        apiKey: this.apiKey,
        modelId: process.env.FAL_VIDEO_MODEL_ID,
        queueBaseUrl: process.env.FAL_QUEUE_BASE_URL,
        timeoutMs: 300_000,
      },
    );
    const position = this.clipPosition;
    this.playout!.enqueue({
      position,
      storyBlockId: frame.storyBlockId,
      videoUrl: generated.videoUrl,
      durationSeconds: this.config.clipDurationSeconds,
    });
    this.clipPosition += 1;
    this.status.clipsRendered += 1;
    await this.waitForPlayback(position);
    frame.groups.forEach((group) => {
      send(this.socket!, this.completedEvent(frame, group, this.config.clipDurationSeconds));
      this.status.dssCommandsRendered += group.commands.length;
    });
    this.status.firstDssAcknowledgedAt ??= new Date().toISOString();
  }

  private async runAudience(joinLink: string): Promise<void> {
    const clients = await Promise.all([openAudience(this.config, joinLink), openAudience(this.config, joinLink)]);
    this.status.audiencePrincipalsDistinct = clients[0].principalId !== clients[1].principalId;
    if (!this.status.audiencePrincipalsDistinct) throw new Error('audience exchanges did not create distinct principals');
    const fanoutKeys = new Set<string>();
    const readerTasks = clients.map(async (client) => {
      while (!this.stopped && client.socket.readyState === WebSocket.OPEN) {
        const message = await client.messages.next(300_000);
        if (message.type === 'websocket.closed') break;
        if (message.type === 'audience.message.accepted') {
          const key = String(message.idempotency_key ?? '');
          const acknowledgement = client.acknowledgements.get(key);
          if (acknowledgement) {
            client.acknowledgements.delete(key);
            acknowledgement(message);
          }
          continue;
        }
        if (message.type === 'audience.error') {
          const key = String(message.idempotency_key ?? '');
          const acknowledgement = client.acknowledgements.get(key);
          if (acknowledgement) {
            client.acknowledgements.delete(key);
            acknowledgement(message);
          }
          continue;
        }
        if (message.type !== 'audience.message.created') continue;
        const chat = asObject(message.message, 'audience chat message');
        const provenance = asObject(chat.provenance, 'audience message provenance');
        const key = String(provenance.source_idempotency_key ?? '');
        if (!key.startsWith('edge-direct-') && !key.startsWith('edge-relay-')) continue;
        const deliveryKey = `${client.principalId}:${key}`;
        if (!fanoutKeys.has(deliveryKey)) {
          fanoutKeys.add(deliveryKey);
          this.status.audienceFanoutDeliveries += 1;
        }
      }
    });
    const sendDirect = async (client: AudienceSocket, payload: JsonObject): Promise<JsonObject> => {
      const key = requiredString(payload.idempotency_key, 'audience idempotency_key');
      const acknowledgement = new Promise<JsonObject>((resolve) => client.acknowledgements.set(key, resolve));
      send(client.socket, payload);
      const result = await Promise.race([
        acknowledgement,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('audience acknowledgement timed out')), 60_000)),
      ]);
      if (result.type === 'audience.error') throw new Error(`audience message failed: ${String(result.code ?? 'unknown')}`);
      return result;
    };
    try {
      const intervalMs = this.config.audienceDurationSeconds * 1_000 / this.config.audienceMessages;
      for (let index = 0; index < this.config.audienceMessages; index += 1) {
        const client = clients[index % clients.length];
        const key = `edge-direct-${randomUUID()}`;
        const payload = {
          type: 'audience.message',
          protocol_version: PROTOCOL_VERSION,
          idempotency_key: key,
          display_name: `API viewer ${(index % clients.length) + 1}`,
          content: `Audience guidance ${index + 1}: pursue the clearest emotional truth and ask a revealing follow-up.`,
        };
        const accepted = await sendDirect(client, payload);
        this.status.audienceDirectSent += 1;
        if (accepted.duplicate === true) throw new Error('new audience message was unexpectedly marked duplicate');
        this.status.audienceDirectAccepted += 1;
        if (index === 0) {
          const duplicate = await sendDirect(client, payload);
          this.status.audienceDuplicateVerified = duplicate.duplicate === true && duplicate.message_id === accepted.message_id;
        }
        if (this.config.enableRendererRelay && index < 5) await this.sendRelay(index);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      const expectedFanout = (this.status.audienceDirectSent + this.status.audienceRelaySent) * clients.length;
      const deadline = Date.now() + 60_000;
      while (this.status.audienceFanoutDeliveries < expectedFanout && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (this.status.audienceFanoutDeliveries !== expectedFanout) {
        throw new Error(`audience fanout incomplete (${this.status.audienceFanoutDeliveries}/${expectedFanout})`);
      }
      if (!this.status.audienceDuplicateVerified) throw new Error('audience duplicate semantics were not verified');
    } finally {
      await Promise.all(clients.map((client) => closeSocket(client.socket)));
      await Promise.allSettled(readerTasks);
    }
  }

  private async sendRelay(index: number): Promise<void> {
    const messageId = `edge-relay-${randomUUID()}`;
    const result = new Promise<JsonObject>((resolve) => this.relayResults.set(messageId, resolve));
    send(this.socket!, {
      type: 'audience.message',
      protocol_version: PROTOCOL_VERSION,
      story_id: this.config.storyId,
      external_subject: `edge-renderer-viewer-${index % 2}`,
      message_id: messageId,
      display_name: 'Renderer viewer',
      content: `Renderer-relayed audience guidance ${index + 1}: follow the unresolved relationship tension.`,
    });
    this.status.audienceRelaySent += 1;
    const accepted = await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('renderer relay acknowledgement timed out')), 60_000)),
    ]);
    this.relayResults.delete(messageId);
    if (accepted.type !== 'audience.message.accepted') throw new Error(`renderer relay failed: ${String(accepted.code ?? accepted.type)}`);
    this.status.audienceRelayAccepted += 1;
  }

  async start(): Promise<void> {
    try {
      this.playout = await this.playoutManager.start({ startupBufferClips: 1 });
      this.status.hlsUrl = this.playout.hlsUrl;
      const loginPayload = await rendererLogin(this.config);
      const websocketUrl = requiredString(loginPayload.websocket_url, 'websocket_url');
      if (!websocketUrl.startsWith('wss://') || new URL(websocketUrl).search) throw new Error('renderer websocket_url must be query-free WSS');
      const accessToken = requiredString(loginPayload.access_token, 'access_token');
      const opened = await openWebSocket(websocketUrl, { Authorization: `Bearer ${accessToken}` });
      this.socket = opened.socket;
      send(this.socket, {
        type: 'renderer.hello',
        protocol_version: PROTOCOL_VERSION,
        stream_id: this.config.rendererId,
        renderer_kind: 'minimax-h3-max-turbo',
        instance_id: `video-renderer-${this.runId}`,
        assignment_id: '',
      });
      const welcome = await opened.messages.matching((item) => item.type === 'renderer.welcome');
      if (welcome.stream_id !== this.config.rendererId || welcome.media_ingest_url !== null) {
        throw new Error('renderer welcome returned mismatched identity or platform media ingest');
      }
      this.status.sessionId = requiredString(welcome.session_id, 'session_id');
      this.status.sessionEpoch = Number(welcome.session_epoch);
      const leaseSeconds = Number(welcome.lease_seconds ?? 30);
      this.heartbeat = setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) send(this.socket, { type: 'renderer.heartbeat' });
      }, Math.max(1_000, Math.floor(leaseSeconds * 1_000 / 4)));
      const assetJson = {
        renderer_version: this.config.rendererVersion,
        provider: 'fal',
        model: process.env.FAL_VIDEO_MODEL_ID ?? 'minimax/h3-max-turbo/text-to-video',
        output: { owner: 'external_renderer', protocol: 'hls' },
      };
      const sha256 = createHash('sha256').update(canonicalJson(assetJson)).digest('hex');
      send(this.socket, {
        type: 'renderer.asset_manifest',
        schema_version: MANIFEST_SCHEMA_VERSION,
        renderer_version: this.config.rendererVersion,
        sha256,
        asset_json: assetJson,
      });
      const manifest = await opened.messages.matching((item) => item.type === 'renderer.asset_manifest.accepted');
      if (manifest.sha256 !== sha256) throw new Error('asset manifest acknowledgement hash mismatch');
      this.status.state = 'running';
      if (!this.config.resumeExistingStory) {
        this.status.storyStartAt = new Date().toISOString();
        const startResponse = await fetch(`${this.config.baseUrl}/api/v1/renderers/start-story`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            renderer_id: this.config.rendererId,
            story_id: this.config.storyId,
            room_id: this.config.roomId,
            config: this.config.storyConfig,
          }),
        });
        this.status.storyStartStatus = startResponse.status;
        const startPayload = await jsonResponse(startResponse, 'renderer story start', 202);
        const audienceGrant = asObject(startPayload.audience_grant, 'audience_grant');
        const grant = asObject(audienceGrant.grant, 'audience grant');
        if (grant.message_channel_id !== this.config.storyMessageChannelId || grant.story_id !== this.config.storyId) {
          throw new Error('renderer story start returned mismatched audience grant');
        }
        if (startPayload.renderer_id !== undefined && startPayload.renderer_id !== this.config.rendererId) {
          throw new Error('renderer story start returned a mismatched renderer ID');
        }
        const joinLink = requiredString(asObject(audienceGrant.join_link, 'audience join link').url, 'audience join link URL');
        this.audienceTask = this.runAudience(joinLink).catch((error) => this.fail(error));
      }
      this.socket.on('close', (code) => {
        if (!this.stopped) this.fail(new Error(`renderer WebSocket closed (${code})`));
      });
      const dssMessages = new AsyncJsonQueue();
      const receiver = (async () => {
        while (!this.stopped && this.socket?.readyState === WebSocket.OPEN) {
          const message = await opened.messages.next(300_000);
          if (message.type === 'websocket.closed') break;
          if (message.type === 'renderer.heartbeat.accepted') {
            this.status.lastHeartbeatAt = new Date().toISOString();
            continue;
          }
          const relayId = message.source_message_id;
          if (typeof relayId === 'string' && this.relayResults.has(relayId)) {
            this.relayResults.get(relayId)!(message);
            continue;
          }
          if (message.script) dssMessages.push(message);
        }
        dssMessages.push({ type: 'websocket.closed' });
      })();
      while (!this.stopped && this.socket.readyState === WebSocket.OPEN) {
        const message = await dssMessages.next(300_000);
        if (message.type === 'websocket.closed') break;
        if (message.stream_id !== this.config.rendererId) throw new Error('DSS command targeted another renderer');
        await this.renderFrame(parseDssFrame(message));
      }
      await receiver;
    } catch (error) {
      if (!this.stopped) this.fail(error);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.socket) await closeSocket(this.socket);
    if (this.audienceTask) await Promise.race([
      this.audienceTask,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (this.playout) await this.playoutManager.stop(this.playout.sessionId);
    if (this.status.state !== 'failed') this.status.state = 'stopped';
  }
}

export class ExternalRendererRunManager {
  private readonly runs = new Map<string, ExternalRendererRun>();

  constructor(private readonly playoutManager: PlayoutManager) {}

  start(value: unknown): ExternalRendererRunStatus {
    const apiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
    if (!apiKey) throw new Error('FAL_KEY is not configured on the renderer server');
    const run = new ExternalRendererRun(parseExternalRendererRunConfig(value), this.playoutManager, apiKey);
    this.runs.set(run.runId, run);
    void run.start();
    return run.status;
  }

  get(runId: string): ExternalRendererRunStatus | null {
    return this.runs.get(runId)?.status ?? null;
  }

  async stop(runId: string): Promise<ExternalRendererRunStatus | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    await run.stop();
    return run.status;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.stop()));
  }
}

export function sendExternalRendererStatus(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
