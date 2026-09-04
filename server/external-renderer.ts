import { createHash, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import WebSocket from 'ws';

import { generateVideo } from './fal.js';
import { generateMiniMaxVideo } from './minimax.js';
import type { PlayoutManager, PlayoutSession } from './playout.js';

type JsonObject = Record<string, unknown>;

interface ExternalRendererRunConfig {
  baseUrl: string;
  environment: string;
  tier: 'renderer-dev' | 'renderer-prod';
  websocketUrl: string | null;
  registerManifest: boolean;
  rendererId: string;
  credentialId: string;
  clientSecret: string;
  rendererVersion: string;
  storyId: number;
  roomId: string;
  roomShortlink: string;
  storyMessageChannelId: string;
  roomMainMessageChannelId: string;
  storyConfig: JsonObject;
  storyStatusBaseUrl: string | null;
  storyStatusToken: string | null;
  resolution: '480P' | '768P';
  clipDurationSeconds: number;
  resumeExistingStory: boolean;
}

interface VideoProvider {
  kind: 'minimax-direct' | 'fal';
  apiKey: string;
}

export interface ExternalRendererRunStatus {
  runId: string;
  state: 'connecting' | 'running' | 'ended' | 'stopped' | 'failed';
  rendererId: string;
  rendererVersion: string;
  storyId: number;
  roomId: string;
  roomShortlink: string;
  storyMessageChannelId: string;
  roomMainMessageChannelId: string;
  sessionId: string | null;
  sessionEpoch: number | null;
  startedAt: string;
  storyStartAt: string | null;
  storyStartStatus: number | null;
  storyEndedAt: string | null;
  firstAssignmentAt: string | null;
  firstDssAcknowledgedAt: string | null;
  dssSequences: number[];
  dssCommandsRendered: number;
  clipsRendered: number;
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

export interface StoryLifecycleObservation {
  state: 'running' | 'ended' | 'failed';
  observedRunning: boolean;
  failure: string | null;
}

export function classifyStoryLifecycle(
  value: unknown,
  previouslyObservedRunning: boolean,
  receivedAssignment: boolean,
): StoryLifecycleObservation {
  const payload = asObject(value, 'story lifecycle response');
  const errors = payload.errors && typeof payload.errors === 'object' && !Array.isArray(payload.errors)
    ? payload.errors as JsonObject
    : {};
  const failure = ['story_error_type', 'story_error_tb', 'stream_error_type', 'stream_error_tb']
    .map((key) => errors[key])
    .find((item) => typeof item === 'string' && item.trim());
  const observedRunning = previouslyObservedRunning
    || payload.active === true
    || (typeof payload.running_key === 'string' && Boolean(payload.running_key));
  if (failure) return { state: 'failed', observedRunning, failure: String(failure).slice(0, 400) };
  if (payload.active === false && payload.running_key == null && (observedRunning || receivedAssignment)) {
    return { state: 'ended', observedRunning, failure: null };
  }
  return { state: 'running', observedRunning, failure: null };
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

function requiredUrl(value: unknown, label: string, environment = 'edge'): string {
  const raw = requiredString(value, label).replace(/\/$/, '');
  const parsed = new URL(raw);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain credentials, query, or fragment`);
  }
  const localHost = ['localhost', '127.0.0.1', 'host.docker.internal'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHost && ['local', 'test'].includes(environment))) {
    throw new Error(`${label} must use HTTPS`);
  }
  return raw;
}

function requiredWebSocketUrl(value: unknown, label: string, environment: string): string {
  const raw = requiredString(value, label);
  const parsed = new URL(raw);
  const localHost = ['localhost', '127.0.0.1', 'host.docker.internal'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain credentials, query, or fragment`);
  }
  if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && localHost && ['local', 'test'].includes(environment))) {
    throw new Error(`${label} must use WSS`);
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
  const environment = requiredString(body.environment ?? 'edge', 'environment');
  const tier = environment === 'prod' || environment === 'demo' ? 'renderer-prod' : 'renderer-dev';
  const validateChannels = body.roomMainMessageChannelId !== undefined;
  const fallbackStoryChannel = '00000000-0000-4000-8000-000000000001';
  const fallbackRoomChannel = '00000000-0000-4000-8000-000000000002';
  const storyConfig = asObject(body.storyConfig ?? { message_channel_ids: [fallbackStoryChannel] }, 'storyConfig');
  const rendererId = uuid(body.rendererId, 'rendererId');
  const configuredChannels = storyConfig.message_channel_ids;
  const storyMessageChannelId = uuid(body.storyMessageChannelId ?? fallbackStoryChannel, 'storyMessageChannelId');
  if (validateChannels && (!Array.isArray(configuredChannels) || configuredChannels.length !== 1 || configuredChannels[0] !== storyMessageChannelId)) {
    throw new Error('storyConfig.message_channel_ids must contain only storyMessageChannelId');
  }
  const roomMainMessageChannelId = uuid(body.roomMainMessageChannelId ?? fallbackRoomChannel, 'roomMainMessageChannelId');
  if (validateChannels && storyMessageChannelId === roomMainMessageChannelId) throw new Error('story and room-main channels must be distinct');
  const resolution = body.resolution ?? '480P';
  if (resolution !== '480P' && resolution !== '768P') throw new Error('resolution must be 480P or 768P');
  const clipDurationSeconds = positiveInteger(body.clipDurationSeconds, 6, 'clipDurationSeconds');
  if (clipDurationSeconds < 5 || clipDurationSeconds > 15) throw new Error('clipDurationSeconds must be 5-15');
  const rendererVersion = requiredString(body.rendererVersion, 'rendererVersion');
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){3}$/.test(rendererVersion)) {
    throw new Error('rendererVersion must contain exactly four dot-separated components');
  }
  return {
    baseUrl: requiredUrl(body.baseUrl ?? 'https://edge.pickford.ai', 'baseUrl', environment),
    environment,
    tier,
    websocketUrl: body.websocketUrl === undefined ? null : requiredWebSocketUrl(body.websocketUrl, 'websocketUrl', environment),
    registerManifest: body.registerManifest !== false,
    rendererId,
    credentialId: uuid(body.credentialId, 'credentialId'),
    clientSecret: requiredString(body.clientSecret, 'clientSecret'),
    rendererVersion,
    storyId: positiveInteger(body.storyId, 1, 'storyId'),
    roomId: uuid(body.roomId ?? '00000000-0000-4000-8000-000000000003', 'roomId'),
    roomShortlink: typeof body.roomShortlink === 'string' ? body.roomShortlink : '',
    storyMessageChannelId,
    roomMainMessageChannelId,
    storyConfig,
    storyStatusBaseUrl: body.storyStatusBaseUrl === undefined
      ? null
      : requiredUrl(body.storyStatusBaseUrl, 'storyStatusBaseUrl', environment),
    storyStatusToken: body.storyStatusToken === undefined ? null : requiredString(body.storyStatusToken, 'storyStatusToken'),
    resolution,
    clipDurationSeconds,
    resumeExistingStory: body.resumeExistingStory === true,
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
      if (value.type === 'websocket.closed') throw new Error('Renderer connection closed');
      if (predicate(value)) {
        skipped.forEach((item) => this.push(item));
        return value;
      }
      skipped.push(value);
    }
  }
}

function openWebSocket(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ socket: WebSocket; messages: AsyncJsonQueue }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 30_000 });
    const messages = new AsyncJsonQueue();
    const onAbort = () => {
      socket.terminate();
      reject(signal?.reason ?? new DOMException('Renderer stopped', 'AbortError'));
    };
    const onError = (error: Error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('error', onError);
    socket.once('open', () => {
      signal?.removeEventListener('abort', onAbort);
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

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Renderer stopped', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function commandName(command: JsonObject): string {
  return String(command.command ?? '').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
}

const NO_VIDEO_CONTROL_COMMANDS = new Set([
  'addcharacter',
  'spawncharacter',
  'enableset',
  'cutscene',
  'showtitle',
  'showcredits',
  'credits',
  'delay',
  'fade',
  'showdebug',
  'setfps',
  'setstorymode',
  'setchannelvolume',
  'depthoffield',
  'stopaudio',
]);

export function controlGroupDurationSeconds(group: DssGroup): number | null {
  if (!group.commands.every((command) => NO_VIDEO_CONTROL_COMMANDS.has(commandName(command).replace(/\s/g, '')))) return null;
  return group.commands.reduce((maximum, command) => {
    const args = commandArgs(command);
    const durations = [args.duration, args.duration_seconds, args.seconds]
      .filter((value) => value !== undefined && value !== null)
      .map(Number).filter((value) => Number.isFinite(value) && value >= 0);
    const delay = Number(command.delay ?? 0);
    return Math.max(maximum, (Number.isFinite(delay) ? Math.max(0, delay) : 0) + Math.max(0, ...durations));
  }, 0);
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
      id: requiredString(group.id, `DSS group ${index} id`),
      commands: commands.map((command, commandIndex) => asObject(command, `DSS command ${commandIndex}`)),
    };
  });
  return {
    raw,
    sequence,
    assignmentId: String(raw.assignment_id ?? ''),
    assignmentGeneration: Number(raw.assignment_generation ?? 0),
    storyBlockId: uuid(raw.story_block_id ?? script.story_block_id, 'DSS story_block_id'),
    groups,
  };
}

export function planGroupClips(frame: DssFrame, group: DssGroup, durationSeconds: number, sceneContext: string[] = []): PlannedClip[] {
  const visual: string[] = [...sceneContext];
  let hasVisualAction = false;
  const dialogue: Array<{ direction: string; words: string[] }> = [];
  for (const command of group.commands) {
    const name = commandName(command);
    const compact = name.replace(/\s/g, '');
    if (!NO_VIDEO_CONTROL_COMMANDS.has(compact) && !['talk', 'charactertalk', 'setemotion', 'playanimation', 'look'].includes(compact)) {
      throw new Error(`Unsupported DSS command: ${name || '(missing command)'}`);
    }
    const character = textArg(command, 'character') ?? textArg(command, 'name');
    if (compact === 'talk' || compact === 'charactertalk') {
      const line = textArg(command, 'dialogue');
      if (!line) continue;
      const respondent = textArg(command, 'respondent');
      const tone = textArg(command, 'tone');
      const speaker = character ?? 'A character';
      dialogue.push({
        direction: `${speaker}${tone ? ` (${tone})` : ''} speaks${respondent ? ` to ${respondent}` : ''}`,
        words: line.split(/\s+/).filter(Boolean),
      });
      continue;
    }
    if (compact === 'enableset') {
      const setName = textArg(command, 'set');
      if (setName) {
        sceneContext.splice(0, sceneContext.length, `Setting: ${setName}.`);
        visual.splice(0, visual.length, ...sceneContext);
      }
    } else if (compact === 'addcharacter' || compact === 'spawncharacter') {
      if (character) {
        const description = `${character} is present in the scene.`;
        if (!sceneContext.includes(description)) sceneContext.push(description);
        if (!visual.includes(description)) visual.push(description);
      }
    } else if (compact === 'look') {
      const target = asObject(commandArgs(command).target, 'look target');
      const targetName = requiredString(target.name, 'look target name');
      if (!character) throw new Error('look character is required');
      const prefix = `${character} looks toward `;
      const direction = `${prefix}${targetName}${target.bias === 'eyes' ? ', making eye contact' : ''}.`;
      for (const context of [sceneContext, visual]) {
        const previous = context.findIndex((value) => value.startsWith(prefix));
        if (previous >= 0) context.splice(previous, 1);
        context.push(direction);
      }
      hasVisualAction = true;
    } else if (compact === 'setemotion') {
      const emotion = textArg(command, 'emotion');
      if (character && emotion) { visual.push(`${character}'s expression is ${emotion}.`); hasVisualAction = true; }
    } else if (compact === 'playanimation') {
      const animation = textArg(command, 'animation');
      if (character && animation) { visual.push(`${character} performs ${animation}.`); hasVisualAction = true; }
    } else if (compact === 'cutscene') {
      continue;
    }
  }
  if (dialogue.length === 0 && !hasVisualAction) return [];
  const chunks: Array<{ text: string; duration: number }> = [];
  for (const line of dialogue) {
    const wordsPerClip = Math.max(1, Math.floor((15 - 1.25) * 2.3));
    for (let index = 0; index < line.words.length; index += wordsPerClip) {
      const words = line.words.slice(index, index + wordsPerClip);
      chunks.push({
        text: `${line.direction}: “${words.join(' ')}”`,
        duration: Math.min(15, Math.max(durationSeconds, Math.ceil(words.length / 2.3 + 1.25))),
      });
    }
  }
  if (chunks.length === 0) chunks.push({ text: '', duration: durationSeconds });
  return chunks.map((chunk, index) => ({
    groupId: group.id,
    storyBlockId: `${frame.storyBlockId}:${group.id}:${index}`,
    durationSeconds: chunk.duration,
    prompt: [
      'Cinematic live-action story scene, expressive natural performances, moody practical lighting, shallow depth of field, coherent characters, subtle ambient sound, no titles or captions.',
      ...visual,
      chunk.text,
      `Let this focused moment unfold naturally across the full ${chunk.duration}-second shot. Preserve character identity and conversational continuity.`,
    ].filter(Boolean).join(' '),
  }));
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

async function rendererLogin(config: ExternalRendererRunConfig, signal?: AbortSignal): Promise<JsonObject> {
  const basic = Buffer.from(`${config.credentialId}:${config.clientSecret}`).toString('base64');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`${config.baseUrl}/api/v1/renderers/login`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        renderer_id: config.rendererId,
        subject: 'client_credential',
        tier: config.tier,
        environment: config.environment,
      }),
    });
    if (response.status !== 429) return await jsonResponse(response, 'renderer login', 200);
    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '1', 10);
    await abortable(new Promise((resolve) => setTimeout(resolve, Math.max(1, retryAfter) * 1_000)), signal ?? new AbortController().signal);
  }
  throw new Error('renderer login remained rate limited after sequential Retry-After waits');
}

function rendererWebSocketUrl(config: ExternalRendererRunConfig, advertised: unknown): string {
  const raw = requiredString(advertised, 'websocket_url');
  const url = new URL(raw);
  if (url.search) throw new Error('renderer websocket_url must be query-free');
  const service = new URL(config.baseUrl);
  const localService = service.protocol === 'http:' && ['localhost', '127.0.0.1', 'host.docker.internal'].includes(service.hostname);
  if (localService && url.hostname.endsWith('.local')) {
    url.protocol = 'ws:';
    url.hostname = service.hostname;
    url.port = service.port;
  }
  if (url.protocol !== 'wss:' && !(localService && url.protocol === 'ws:')) {
    throw new Error('renderer websocket_url must use WSS (or WS for a loopback service)');
  }
  return url.toString();
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
  private readonly sceneContext: string[] = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly seenDss = new Set<string>();
  private readonly abortController = new AbortController();

  constructor(
    private readonly config: ExternalRendererRunConfig,
    private readonly playoutManager: PlayoutManager,
    private readonly provider: VideoProvider,
  ) {
    this.status = {
      runId: this.runId,
      state: 'connecting',
      rendererId: config.rendererId,
      rendererVersion: config.rendererVersion,
      storyId: config.storyId,
      roomId: config.roomId,
      roomShortlink: config.roomShortlink,
      storyMessageChannelId: config.storyMessageChannelId,
      roomMainMessageChannelId: config.roomMainMessageChannelId,
      sessionId: null,
      sessionEpoch: null,
      startedAt: new Date().toISOString(),
      storyStartAt: null,
      storyStartStatus: null,
      storyEndedAt: null,
      firstAssignmentAt: null,
      firstDssAcknowledgedAt: null,
      dssSequences: [],
      dssCommandsRendered: 0,
      clipsRendered: 0,
      hlsUrl: null,
      lastHeartbeatAt: null,
      failures: [],
    };
  }

  private fail(error: unknown): void {
    let detail = error instanceof Error ? error.message : String(error);
    for (const secret of [this.config.clientSecret, this.provider.apiKey, this.config.storyStatusToken]) {
      if (secret) detail = detail.replaceAll(secret, '[redacted]');
    }
    this.status.failures.push(detail.slice(0, 500));
    this.status.failures.splice(0, Math.max(0, this.status.failures.length - MAX_FAILURES));
    this.status.state = 'failed';
    void this.closeResources();
  }

  private async closeResources(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort(new DOMException('Renderer stopped', 'AbortError'));
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.socket) await closeSocket(this.socket);
    if (this.playout) await this.playoutManager.stop(this.playout.sessionId);
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
    for (const group of frame.groups) {
      if (group.commands.length === 0 || frame.sequence === 0) {
        send(this.socket!, this.completedEvent(frame, group, 0));
        continue;
      }
      const planned = planGroupClips(frame, group, this.config.clipDurationSeconds, this.sceneContext);
      if (planned.length === 0) {
        const controlDuration = controlGroupDurationSeconds(group);
        if (controlDuration === null) throw new Error(`DSS group ${group.id} contains no supported renderable commands`);
        if (controlDuration > 0) await abortable(
          new Promise((resolve) => setTimeout(resolve, controlDuration * 1_000)), this.abortController.signal,
        );
        if (this.stopped) throw this.abortController.signal.reason;
        send(this.socket!, this.completedEvent(frame, group, controlDuration));
        this.status.dssCommandsRendered += group.commands.length;
        continue;
      }
      send(this.socket!, this.progressEvent(frame, group, 0, group.commands.length));
      let playedSeconds = 0;
      for (const clip of planned) {
        if (this.stopped) throw this.abortController.signal.reason;
        const input = {
          prompt: clip.prompt,
          duration: clip.durationSeconds,
          resolution: this.config.resolution,
          aspectRatio: '16:9' as const,
        };
        const generated = this.provider.kind === 'minimax-direct'
          ? await generateMiniMaxVideo(input, {
              apiKey: this.provider.apiKey,
              baseUrl: process.env.MINIMAX_API_BASE_URL,
              textModel: process.env.MINIMAX_VIDEO_MODEL_ID,
              referenceModel: process.env.MINIMAX_REFERENCE_VIDEO_MODEL_ID,
              timeoutMs: 300_000,
              signal: this.abortController.signal,
            })
          : await generateVideo(input, {
              apiKey: this.provider.apiKey,
              modelId: process.env.FAL_VIDEO_MODEL_ID,
              queueBaseUrl: process.env.FAL_QUEUE_BASE_URL,
              timeoutMs: 300_000,
              signal: this.abortController.signal,
            });
        if (this.stopped) throw this.abortController.signal.reason;
        const position = this.clipPosition;
        this.playout!.enqueue({
          position,
          storyBlockId: clip.storyBlockId,
          videoUrl: generated.videoUrl,
          durationSeconds: clip.durationSeconds,
        });
        this.clipPosition += 1;
        this.status.clipsRendered += 1;
        await this.waitForPlayback(position);
        playedSeconds += clip.durationSeconds;
      }
      send(this.socket!, this.completedEvent(frame, group, playedSeconds));
      this.status.dssCommandsRendered += group.commands.length;
    }
    this.status.firstDssAcknowledgedAt ??= new Date().toISOString();
  }

  private async observeStoryLifecycle(): Promise<void> {
    if (!this.config.storyStatusBaseUrl || !this.config.storyStatusToken) return;
    let observedRunning = false;
    while (!this.stopped) {
      const response = await fetch(`${this.config.storyStatusBaseUrl}/story/?id=${this.config.storyId}`, {
        headers: { Authorization: `Bearer ${this.config.storyStatusToken}` },
        signal: this.abortController.signal,
      });
      const payload = await jsonResponse(response, 'story lifecycle read', 200);
      const observation = classifyStoryLifecycle(payload, observedRunning, this.status.firstAssignmentAt !== null);
      observedRunning = observation.observedRunning;
      if (observation.state === 'failed') {
        throw new Error(`Story ${this.config.storyId} failed: ${observation.failure}`);
      }
      if (observation.state === 'ended') {
        this.status.storyEndedAt = new Date().toISOString();
        this.status.state = 'ended';
        await this.closeResources();
        return;
      }
      await abortable(new Promise((resolve) => setTimeout(resolve, 1_000)), this.abortController.signal);
    }
  }

  async start(): Promise<void> {
    try {
      const playout = await this.playoutManager.start({ startupBufferClips: 1 });
      if (this.stopped) { await this.playoutManager.stop(playout.sessionId); return; }
      this.playout = playout;
      this.status.hlsUrl = this.playout.hlsUrl;
      const loginPayload = await rendererLogin(this.config, this.abortController.signal);
      if (this.stopped) return;
      const websocketUrl = this.config.websocketUrl ?? rendererWebSocketUrl(this.config, loginPayload.websocket_url);
      requiredWebSocketUrl(websocketUrl, 'renderer websocket_url', this.config.environment);
      const accessToken = requiredString(loginPayload.access_token, 'access_token');
      const opened = await openWebSocket(
        websocketUrl,
        { Authorization: `Bearer ${accessToken}` },
        this.abortController.signal,
      );
      if (this.stopped) { await closeSocket(opened.socket); return; }
      this.socket = opened.socket;
      send(this.socket, {
        type: 'renderer.hello',
        protocol_version: PROTOCOL_VERSION,
        stream_id: this.config.rendererId,
        renderer_kind: this.provider.kind === 'minimax-direct' ? 'minimax-h3-max' : 'minimax-h3-max-turbo',
        instance_id: `video-renderer-${this.runId}`,
        assignment_id: '',
      });
      const welcome = await abortable(
        opened.messages.matching((item) => item.type === 'renderer.welcome'),
        this.abortController.signal,
      );
      if (this.stopped) return;
      if (welcome.stream_id !== this.config.rendererId || welcome.media_ingest_url !== null) {
        throw new Error('renderer welcome returned mismatched identity or platform media ingest');
      }
      this.status.sessionId = requiredString(welcome.session_id, 'session_id');
      this.status.sessionEpoch = Number(welcome.session_epoch);
      const leaseSeconds = Number(welcome.lease_seconds ?? 30);
      this.heartbeat = setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) send(this.socket, { type: 'renderer.heartbeat' });
      }, Math.max(1_000, Math.floor(leaseSeconds * 1_000 / 4)));
      if (this.config.registerManifest) {
        const assetJson = {
          renderer_version: this.config.rendererVersion,
          provider: this.provider.kind,
          model: this.provider.kind === 'minimax-direct'
            ? process.env.MINIMAX_VIDEO_MODEL_ID ?? 'MiniMax-H3-Max'
            : process.env.FAL_VIDEO_MODEL_ID ?? 'minimax/h3-max-turbo/text-to-video',
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
      }
      if (!this.config.resumeExistingStory) {
        this.status.storyStartAt = new Date().toISOString();
        const startResponse = await fetch(`${this.config.baseUrl}/api/v1/renderers/start-story`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          signal: this.abortController.signal,
          body: JSON.stringify({
            renderer_id: this.config.rendererId,
            story_id: this.config.storyId,
            room_id: this.config.roomId,
            config: this.config.storyConfig,
          }),
        });
        this.status.storyStartStatus = startResponse.status;
        const startPayload = await jsonResponse(startResponse, 'renderer story start', 202);
        if (this.stopped) return;
        if (startPayload.renderer_id !== undefined && startPayload.renderer_id !== this.config.rendererId) {
          throw new Error('renderer story start returned a mismatched renderer ID');
        }
      }
      if (this.stopped) return;
      this.status.state = 'running';
      void this.observeStoryLifecycle().catch((error) => {
        if (!this.stopped) this.fail(error);
      });
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
          if (message.script) dssMessages.push(message);
        }
        dssMessages.push({ type: 'websocket.closed' });
      })().catch(error => {
        if (!this.stopped) this.fail(error);
        dssMessages.push({ type: 'websocket.closed' });
      });
      while (!this.stopped && this.socket.readyState === WebSocket.OPEN) {
        const message = await dssMessages.next(this.status.firstAssignmentAt ? 300_000 : 60_000);
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
    const preserveState = this.status.state === 'failed' || this.status.state === 'ended';
    await this.closeResources();
    if (!preserveState) this.status.state = 'stopped';
  }
}

export class ExternalRendererRunManager {
  private readonly runs = new Map<string, ExternalRendererRun>();
  private activeRunId: string | null = null;

  constructor(private readonly playoutManager: PlayoutManager) {}

  start(value: unknown): ExternalRendererRunStatus {
    if ([...this.runs.values()].some(run => ['connecting', 'running'].includes(run.status.state))) {
      throw new Error('A renderer run is already active. Stop it before starting another.');
    }
    for (const [id, run] of this.runs) {
      if (['stopped', 'failed', 'ended'].includes(run.status.state)) this.runs.delete(id);
    }
    const minimaxKey = process.env.MINIMAX_API_KEY;
    const falKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
    const provider: VideoProvider | null = minimaxKey
      ? { kind: 'minimax-direct', apiKey: minimaxKey }
      : falKey ? { kind: 'fal', apiKey: falKey } : null;
    if (!provider) throw new Error('MINIMAX_API_KEY or FAL_KEY is not configured on the renderer server');
    const run = new ExternalRendererRun(parseExternalRendererRunConfig(value), this.playoutManager, provider);
    this.runs.set(run.runId, run);
    this.activeRunId = run.runId;
    void run.start();
    return run.status;
  }

  startConfigured(story: unknown): ExternalRendererRunStatus {
    const requiredEnvironment = (name: string): string => {
      const value = process.env[name]?.trim();
      if (!value) throw new Error(`${name} is not configured on the renderer server`);
      return value;
    };
    const prepared = asObject(story, 'prepared story');
    return this.start({
      baseUrl: requiredEnvironment('RENDERER_PLATFORM_BASE_URL'),
      websocketUrl: process.env.RENDERER_PLATFORM_WEBSOCKET_URL,
      environment: process.env.RENDERER_PLATFORM_ENVIRONMENT ?? 'local',
      rendererId: requiredEnvironment('RENDERER_ID'),
      credentialId: requiredEnvironment('RENDERER_CREDENTIAL_ID'),
      clientSecret: requiredEnvironment('RENDERER_CLIENT_SECRET'),
      rendererVersion: process.env.RENDERER_VERSION ?? 'minimax.20260904.local.1',
      registerManifest: process.env.RENDERER_REGISTER_MANIFEST !== 'false',
      storyId: prepared.storyId,
      roomId: prepared.roomId,
      storyMessageChannelId: prepared.storyMessageChannelId,
      storyConfig: prepared.storyConfig,
      storyStatusBaseUrl: prepared.storyStatusBaseUrl,
      storyStatusToken: prepared.storyStatusToken,
      resumeExistingStory: false,
      resolution: process.env.RENDERER_RESOLUTION ?? '480P',
      clipDurationSeconds: Number.parseInt(process.env.RENDERER_CLIP_DURATION_SECONDS ?? '5', 10),
    });
  }

  active(): ExternalRendererRunStatus | null {
    return this.activeRunId ? this.get(this.activeRunId) : null;
  }

  async stopActive(expectedRunId?: string): Promise<ExternalRendererRunStatus | null> {
    const runId = this.activeRunId;
    if (expectedRunId && runId !== expectedRunId) return null;
    this.activeRunId = null;
    return runId ? await this.stop(runId) : null;
  }

  get(runId: string): ExternalRendererRunStatus | null {
    return this.runs.get(runId)?.status ?? null;
  }

  async stop(runId: string): Promise<ExternalRendererRunStatus | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    await run.stop();
    if (this.activeRunId === runId) this.activeRunId = null;
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
