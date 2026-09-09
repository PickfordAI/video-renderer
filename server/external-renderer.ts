import { createHash, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import WebSocket from 'ws';

import { generateVideo } from './fal.js';
import { falReferenceUploader, sceneAssetTransport } from './fal-storage.js';
import { ffmpegReferenceDownscaler } from './image-downscale.js';
import { defaultRequestTimeoutMs } from './provider-timeouts.js';
import { generateMiniMaxVideo } from './minimax.js';
import { parseRendererConfig, parseInitialImageUrl, type RenderMode, type RendererConfig, type ContinuityStrategy } from './render-mode.js';
import { DssShotPlanner, type ShotPlannerSettings, type PlannedShot, type PlannedGroup } from './shot-planner.js';
import { ShotScheduler, type ScheduledShot } from './shot-scheduler.js';
import { ShotGenerator, type GeneratedShot } from './shot-generation.js';
import { PreparedFrameQueue } from './prepared-frame-queue.js';
import { requestStoryStart, requestTransientDependency, type TransientDependencyRetry } from './story-start.js';
import { storyStartRefusalMessage } from './story-bundles.js';
import { rendererEventId, RendererEventVerdicts, type RendererEventVerdictStatus, type VerdictAcknowledgement } from './renderer-event-verdicts.js';
import { MinimaxSceneAssetCache, parseMinimaxSceneContext, sceneContextImageUrls, sceneContextPrompt, type MinimaxSceneContext } from './scene-context.js';
import type { PlayoutClipBoundary, PlayoutClipInput, PlayoutStatus } from './playout.js';

type JsonObject = Record<string, unknown>;

/** `legacy` pre-provisions a story; `opaque` lets the kernel allocate it from an EVD (PIC-1545). */
export type StoryStartMode = 'legacy' | 'opaque';

export const AUDIENCE_EXCHANGE_PATH = '/api/v1/external-audience/exchange';

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
  startMode: StoryStartMode;
  evdId: string | null;
  audienceExchangeUrl: string | null;
  storyId: number | null;
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
  /** Creator intent to replace this renderer's prior Story Run before admitting this one. */
  supersedeExistingStory: boolean;
  renderMode: RenderMode;
  rendererConfig: RendererConfig;
  continuityStrategy: ContinuityStrategy;
  initialImageUrl?: string;
  generationConcurrency: number;
  maxBufferedSeconds: number;
  shotPlanner: ShotPlannerSettings;
}

interface VideoProvider {
  kind: 'minimax-direct' | 'fal';
  apiKey: string;
  fakeClips: boolean;
}

export interface ExternalPlayoutSession {
  readonly sessionId: string;
  readonly hlsUrl: string;
  enqueue(value: unknown, onDuration?: (seconds: number) => void): PlayoutClipInput;
  status(): PlayoutStatus;
  clipBoundary?(position: number): PlayoutClipBoundary | null;
}

export interface ExternalPlayoutManager {
  start(options?: { startupBufferClips?: number; startupWaitMs?: number }): Promise<ExternalPlayoutSession>;
  stop(sessionId: string): Promise<boolean>;
}

/** How a shot used the camera-anchor cache: it established the key, reused it, or the run has no anchors. */
export type ClipAnchorRole = 'establish' | 'reuse' | 'none';

export interface RendererClipRecord {
  shotId: string;
  groupId: string;
  storyBlockId: string;
  sequence: number;
  position: number;
  durationSeconds: number;
  /** When the provider call actually began, which is after any scheduler or dependency wait. */
  submittedAt: string | null;
  readyAt: string | null;
  generationMs: number | null;
  playedAt: string | null;
  providerRequestId: string | null;
  continuity: ContinuityStrategy;
  anchor: ClipAnchorRole;
  anchorKey: string | null;
  /** Output-timeline placement once the playout has fed this clip; null before that. */
  streamStartSeconds: number | null;
  streamEndSeconds: number | null;
  /** Stall hold-frame seconds the audience saw between the previous clip's end and this clip's start. */
  gapBeforeSeconds: number | null;
  /** Kernel-commanded pause (timed control such as `fade`) fed before this clip; deliberate, not a gap. */
  leadInBeforeSeconds: number | null;
  /** fal-side timing: how long the submit call took to return a request id, seconds from that
   *  acknowledgement to completion, and the deepest queue position reported while waiting. */
  falSubmitSeconds: number | null;
  falQueueSeconds: number | null;
  /** Whole provider call: submit + queue + result fetch. generationMs minus this is renderer-side work such as frame extraction. */
  falTotalSeconds: number | null;
  falMaxQueuePosition: number | null;
  /** `line`: previous clip belonged to the same story block; `block`: a block boundary; `start`: first clip. */
  gapKind: PlaybackGapKind | null;
}

export type PlaybackGapKind = 'line' | 'block' | 'start';

/** Dead air the playout had to fill with hold frames, split by where it fell in the story. */
export interface PlaybackGapSummary {
  /** Gaps between two clips of the same story block: inside a scene, between lines. */
  lineGapCount: number;
  lineGapSeconds: number;
  maxLineGapSeconds: number;
  /** Gaps between the last clip of one story block and the first of the next. */
  blockGapCount: number;
  blockGapSeconds: number;
  maxBlockGapSeconds: number;
  /** Clips whose placement is known, i.e. the denominator for the counts above. */
  clipsPlaced: number;
}

/**
 * Per-group provider timing reported to the kernel on group_finished, so the admin Per-Line
 * Timeline can draw a `fal` bar next to parse/tts/upload. One DSS group is one line (a split
 * line yields several clips, which are summed).
 */
export interface GroupRenderMetrics {
  provider: 'fal' | 'minimax-direct';
  clips: number;
  submitted_at: string | null;
  ready_at: string | null;
  played_at: string | null;
  generation_ms: number | null;
  fal_submit_seconds: number | null;
  fal_queue_seconds: number | null;
  fal_total_seconds: number | null;
  gap_before_seconds: number | null;
  lead_in_seconds: number | null;
}

export function groupRenderMetrics(records: readonly RendererClipRecord[], provider: GroupRenderMetrics['provider'] = 'fal'): GroupRenderMetrics | null {
  if (records.length === 0) return null;
  const isoMin = (values: Array<string | null>) => values.filter((v): v is string => v !== null).sort()[0] ?? null;
  const isoMax = (values: Array<string | null>) => values.filter((v): v is string => v !== null).sort().at(-1) ?? null;
  const sum = (values: Array<number | null>) => {
    const present = values.filter((v): v is number => typeof v === 'number');
    return present.length ? Math.round(present.reduce((a, b) => a + b, 0) * 10) / 10 : null;
  };
  return {
    provider,
    clips: records.length,
    submitted_at: isoMin(records.map(r => r.submittedAt)),
    ready_at: isoMax(records.map(r => r.readyAt)),
    played_at: isoMax(records.map(r => r.playedAt)),
    generation_ms: sum(records.map(r => r.generationMs)),
    fal_submit_seconds: sum(records.map(r => r.falSubmitSeconds)),
    fal_queue_seconds: sum(records.map(r => r.falQueueSeconds)),
    fal_total_seconds: sum(records.map(r => r.falTotalSeconds)),
    gap_before_seconds: records[0]?.gapBeforeSeconds ?? null,
    lead_in_seconds: records[0]?.leadInBeforeSeconds ?? null,
  };
}

export function emptyPlaybackGapSummary(): PlaybackGapSummary {
  return { lineGapCount: 0, lineGapSeconds: 0, maxLineGapSeconds: 0, blockGapCount: 0, blockGapSeconds: 0, maxBlockGapSeconds: 0, clipsPlaced: 0 };
}

export interface GenerationMsPercentiles {
  min: number;
  median: number;
  max: number;
}

export interface ExternalRendererRunStatus {
  runId: string;
  state: 'connecting' | 'running' | 'ended' | 'stopped' | 'failed';
  rendererId: string;
  rendererVersion: string;
  /** True only for the explicit local smoke-test mode; no provider or media renderer was used. */
  fakeClips: boolean;
  startMode: StoryStartMode;
  storyRunId: string | null;
  audienceJoinUrl: string | null;
  storyId: number | null;
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
  clips: RendererClipRecord[];
  anchorsEstablished: number;
  anchorsReused: number;
  generationMsPercentiles: GenerationMsPercentiles | null;
  playbackGaps: PlaybackGapSummary;
  mediaDir: string | null;
  finalMp4: string | null;
  hlsUrl: string | null;
  lastHeartbeatAt: string | null;
  eventVerdicts: RendererEventVerdictStatus;
  failures: string[];
}

export interface AudienceChatMessageInput {
  externalSubject: string;
  displayName: string;
  content: string;
  idempotencyKey: string;
}

export interface AudienceChatMessageResult {
  accepted: boolean;
  messageId?: string;
  duplicate?: boolean;
  code?: string;
  detail?: string;
  retryAfterSeconds?: number;
}

export function createRendererAudienceMessage(storyId: number, input: AudienceChatMessageInput): JsonObject {
  return {
    type: 'audience.message',
    protocol_version: 1,
    story_id: storyId,
    external_subject: input.externalSubject,
    message_id: input.idempotencyKey,
    display_name: input.displayName,
    content: input.content,
  };
}

export function parseRendererAudienceResult(message: JsonObject): { key: string; result: AudienceChatMessageResult } | null {
  if (!['audience.message.accepted', 'audience.message.duplicate', 'audience.message.rejected'].includes(String(message.type))) {
    return null;
  }
  const key = typeof message.source_message_id === 'string'
    ? message.source_message_id
    : typeof message.message_id === 'string'
      ? message.message_id
      : '';
  if (!key) return null;
  if (message.type === 'audience.message.rejected') {
    return {
      key,
      result: {
        accepted: false,
        code: typeof message.code === 'string' ? message.code : 'rejected',
        detail: typeof message.detail === 'string' ? message.detail : 'The story did not accept the message.',
        retryAfterSeconds: typeof message.retry_after_seconds === 'number' ? message.retry_after_seconds : undefined,
      },
    };
  }
  return {
    key,
    result: {
      accepted: true,
      duplicate: message.type === 'audience.message.duplicate',
      messageId: typeof message.message_id === 'string' ? message.message_id : undefined,
    },
  };
}

export interface DssGroup {
  id: string;
  commands: JsonObject[];
}

export interface DssFrame {
  raw: JsonObject;
  sequence: number;
  assignmentId: string;
  assignmentGeneration: number;
  storyBlockId: string;
  episodeId?: number;
  sceneIndex?: number;
  sceneContext?: MinimaxSceneContext | null;
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
const SCRIPT_STARTED_STATUS_ID = 5;
const GROUP_FINISHED_STATUS_ID = 10;
// A duration budget does not bound control-only payloads or unscheduled plans.
const MAX_PREPARED_DSS_FRAMES = 32;
const MAX_PENDING_DSS_FRAMES = 256;
const NATURAL_COMPLETION_DRAIN_MS = 5_000;
const VERDICT_ACK_TIMEOUT_MS = 2_000;
const FAKE_FAILURE_VERDICT_TIMEOUT_MS = 10_000;
const DSS_IDLE_TIMEOUT_MS = 300_000;
const MAX_CLIP_RECORDS = 1_000;
/** Clips that must be rendered before the stream starts; the fallback timer starts a lone clip. */
const STARTUP_BUFFER_CLIPS = positiveIntegerEnv('RENDERER_STARTUP_BUFFER_CLIPS', 2);
/** Fallback so a one-clip or ACK-gated story still starts if the second clip never comes. */
const STARTUP_WAIT_MS = positiveIntegerEnv('RENDERER_STARTUP_WAIT_MS', 45_000);

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export function generationMsPercentiles(records: readonly RendererClipRecord[]): GenerationMsPercentiles | null {
  const samples = records.map(record => record.generationMs).filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (samples.length === 0) return null;
  const middle = (samples.length - 1) / 2;
  return {
    min: samples[0],
    median: Math.round((samples[Math.floor(middle)] + samples[Math.ceil(middle)]) / 2),
    max: samples[samples.length - 1],
  };
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', 'host.docker.internal'];
// A local unified stack runs renderer-platform as ENV=dev behind plain loopback ports.
const LOOPBACK_PLAINTEXT_ENVIRONMENTS = new Set(['local', 'test', 'dev']);

function requiredUrl(value: unknown, label: string, environment = 'prod'): string {
  const raw = requiredString(value, label).replace(/\/$/, '');
  const parsed = new URL(raw);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain credentials, query, or fragment`);
  }
  const localHost = LOOPBACK_HOSTS.includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHost && LOOPBACK_PLAINTEXT_ENVIRONMENTS.has(environment))) {
    throw new Error(`${label} must use HTTPS`);
  }
  return raw;
}

function requiredWebSocketUrl(value: unknown, label: string, environment: string): string {
  const raw = requiredString(value, label);
  const parsed = new URL(raw);
  const localHost = LOOPBACK_HOSTS.includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain credentials, query, or fragment`);
  }
  if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && localHost && LOOPBACK_PLAINTEXT_ENVIRONMENTS.has(environment))) {
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
  const environment = requiredString(body.environment ?? 'prod', 'environment');
  const rendererConfig = parseRendererConfig(body.rendererConfig, body);
  const renderMode = rendererConfig.model;
  const continuityStrategy = rendererConfig.continuity;
  const initialImageUrl = parseInitialImageUrl(body.initialImageUrl);
  if (renderMode === 'fal-turbo-i2v' && !initialImageUrl) throw new Error('fal-turbo-i2v requires initialImageUrl');
  const generationConcurrency = rendererConfig.concurrency;
  const maxBufferedSeconds = rendererConfig.maxBufferedSeconds;
  const shotPlanner = { ...asObject(body.shotPlanner ?? {}, 'shotPlanner') } as ShotPlannerSettings;
  if (body.includeDialogueAudioReferences !== undefined) {
    if (typeof body.includeDialogueAudioReferences !== 'boolean') throw new Error('includeDialogueAudioReferences must be boolean');
    shotPlanner.useDialogueAudioReferences = body.includeDialogueAudioReferences;
  }
  if (renderMode !== 'auto') new DssShotPlanner(shotPlanner);
  const tier = environment === 'prod' || environment === 'demo' ? 'renderer-prod' : 'renderer-dev';
  const validateChannels = body.roomMainMessageChannelId !== undefined;
  const fallbackStoryChannel = '00000000-0000-4000-8000-000000000001';
  const fallbackRoomChannel = '00000000-0000-4000-8000-000000000002';
  const storyConfig = asObject(body.storyConfig ?? { message_channel_ids: [fallbackStoryChannel] }, 'storyConfig');
  const resumeExistingStory = body.resumeExistingStory === true;
  const startMode = body.startMode ?? 'legacy';
  if (startMode !== 'legacy' && startMode !== 'opaque') throw new Error('startMode must be legacy or opaque');
  const opaque = startMode === 'opaque';
  if (body.supersedeExistingStory !== undefined && typeof body.supersedeExistingStory !== 'boolean') {
    throw new Error('supersedeExistingStory must be boolean');
  }
  const supersedeExistingStory = body.supersedeExistingStory === true;
  if (supersedeExistingStory && !opaque) throw new Error('supersedeExistingStory requires opaque start mode');
  const evdId = opaque ? uuid(body.evdId ?? storyConfig.evd_id, 'evdId') : null;
  if (body.storyConfig !== undefined && !resumeExistingStory && !opaque) {
    uuid(storyConfig.evd_id, 'storyConfig.evd_id');
    if (!['MINIMAX', 'CREATOR', 'WHISPERS'].includes(String(storyConfig.base_structure))) {
      throw new Error('storyConfig.base_structure must be MINIMAX, CREATOR, or WHISPERS');
    }
  }
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
    baseUrl: requiredUrl(body.baseUrl ?? 'https://pickford.ai', 'baseUrl', environment),
    environment,
    tier,
    renderMode, rendererConfig, continuityStrategy, initialImageUrl, generationConcurrency, maxBufferedSeconds, shotPlanner,
    websocketUrl: body.websocketUrl === undefined ? null : requiredWebSocketUrl(body.websocketUrl, 'websocketUrl', environment),
    registerManifest: body.registerManifest !== false,
    rendererId,
    credentialId: uuid(body.credentialId, 'credentialId'),
    clientSecret: requiredString(body.clientSecret, 'clientSecret'),
    rendererVersion,
    startMode,
    evdId,
    audienceExchangeUrl: body.audienceExchangeUrl === undefined
      ? null
      : requiredUrl(body.audienceExchangeUrl, 'audienceExchangeUrl', environment),
    storyId: opaque && body.storyId === undefined ? null : positiveInteger(body.storyId, 1, 'storyId'),
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
    resumeExistingStory,
    supersedeExistingStory,
  };
}

class AsyncJsonQueue {
  private readonly values: JsonObject[] = [];
  private readonly waiters: Array<(value: JsonObject) => void> = [];

  constructor(private readonly capacity = Number.POSITIVE_INFINITY) {}

  push(value: JsonObject): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else {
      if (this.values.length >= this.capacity) throw new Error('DSS receive buffer exceeded its capacity');
      this.values.push(value);
    }
  }

  async next(timeoutMs: number | null = 60_000, signal?: AbortSignal): Promise<JsonObject> {
    signal?.throwIfAborted();
    const value = this.values.shift();
    if (value) return value;
    return await new Promise<JsonObject>((resolve, reject) => {
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      const onAbort = () => { cleanup(); reject(signal?.reason); };
      const waiter = (item: JsonObject) => {
        cleanup();
        resolve(item);
      };
      const timeout = timeoutMs === null ? null : setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for a WebSocket message'));
      }, timeoutMs);
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
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

function waitWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
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

export function parseDssFrame(raw: JsonObject): DssFrame {
  const script = asObject(raw.script, 'DSS script');
  const sequence = Number(script.sequence ?? raw.sequence);
  const episodeId = script.episode_id ?? raw.episode_id ?? undefined;
  if (episodeId !== undefined && (!Number.isInteger(episodeId) || (episodeId as number) < 0)) throw new Error('DSS episode_id must be a non-negative integer');
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error('DSS sequence must be a non-negative integer');
  const sceneIndex = script.scene_index === undefined || script.scene_index === null ? undefined : Number(script.scene_index);
  if (sceneIndex !== undefined && !Number.isInteger(sceneIndex)) throw new Error('DSS scene_index must be an integer');
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
  const storyType = Number(script.story_type);
  const rawSceneContext = script.scene_context;
  if (rawSceneContext !== undefined && rawSceneContext !== null && storyType !== 4) {
    throw new Error('scene_context is only valid for Minimax DSS');
  }
  const sceneContext = rawSceneContext === undefined || rawSceneContext === null
    ? null
    : parseMinimaxSceneContext(rawSceneContext);
  return {
    raw,
    sequence,
    assignmentId: String(raw.assignment_id ?? ''),
    assignmentGeneration: Number(raw.assignment_generation ?? 0),
    storyBlockId: uuid(raw.story_block_id ?? script.story_block_id, 'DSS story_block_id'),
    episodeId: episodeId as number | undefined,
    sceneIndex,
    sceneContext,
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
    if (!NO_VIDEO_CONTROL_COMMANDS.has(compact) && !['talk', 'charactertalk', 'setemotion', 'playanimation', 'look', 'stillshot'].includes(compact)) {
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
    } else if (compact === 'stillshot') {
      const args = commandArgs(command);
      const shot = textArg(command, 'shot name') ?? textArg(command, 'preset');
      if (!shot) throw new Error('still shot name is required');
      const target = args.target && typeof args.target === 'object' && !Array.isArray(args.target)
        ? textArg({ args: args.target as JsonObject }, 'name')
        : null;
      visual.push(target ? `Camera uses ${shot} framing on ${target}.` : `Camera uses ${shot} framing.`);
      hasVisualAction = true;
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

/**
 * The immutable asset manifest registered under `rendererVersion`. Renderer Platform keys manifests by
 * (renderer, version) and closes the bridge with 4400 when the same version arrives with a different
 * hash, so only inputs that change what gets generated belong here. Scheduler tuning (`concurrency`,
 * `maxBufferedSeconds`) changes pacing, not assets, and is deliberately left out so a creator-UI run and
 * a CLI run that buffer differently register the same manifest instead of colliding.
 */
export function assetManifestFor(
  config: Pick<ExternalRendererRunConfig, 'rendererVersion' | 'renderMode' | 'rendererConfig'>,
  providerKind: VideoProvider['kind'],
  env: NodeJS.ProcessEnv = process.env,
): JsonObject {
  return {
    renderer_version: config.rendererVersion,
    provider: providerKind,
    render_mode: config.renderMode,
    renderer_config: { model: config.rendererConfig.model, continuity: config.rendererConfig.continuity },
    model: config.renderMode === 'fal-turbo-i2v'
      ? 'minimax/h3-max-turbo/image-to-video'
      : config.renderMode === 'fal-max-ref2v'
        ? 'minimax/h3-max/reference-to-video'
        : providerKind === 'minimax-direct'
          ? env.MINIMAX_VIDEO_MODEL_ID ?? 'MiniMax-H3-Max'
          : env.FAL_VIDEO_MODEL_ID ?? 'minimax/h3-max-turbo/text-to-video',
    output: { owner: 'external_renderer', protocol: 'hls' },
  };
}

export function assetManifestSha256(assetJson: JsonObject): string {
  return createHash('sha256').update(canonicalJson(assetJson)).digest('hex');
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
    client_event_id: rendererEventId([input.streamId, input.assignmentId, input.assignmentGeneration, input.sequence, input.storyBlockId, input.groupId, 'command_progress', input.status, input.current, input.total]),
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

export function createScriptStartedEvent(input: {
  streamId: string;
  assignmentId: string;
  assignmentGeneration: number;
  sequence: number;
  groupId: string;
  storyBlockId: string;
}): JsonObject {
  return {
    type: 'renderer.event',
    client_event_id: rendererEventId([input.streamId, input.assignmentId, input.assignmentGeneration, input.storyBlockId, 'script_started']),
    event: 'script_started',
    id: SCRIPT_STATUS_MESSAGE_ID,
    stream_id: input.streamId,
    assignment_id: input.assignmentId,
    assignment_generation: input.assignmentGeneration,
    sequence: input.sequence,
    status: SCRIPT_STARTED_STATUS_ID,
    duration: 0,
    dss_id: input.groupId,
    timestamp: Date.now() / 1_000,
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
  /** Story Kernel episode id; lets the kernel attribute render metrics without a lookup. */
  episodeId?: number;
  renderMetrics?: GroupRenderMetrics | null;
}): JsonObject {
  return {
    type: 'renderer.event',
    ...(input.episodeId !== undefined ? { episode_id: input.episodeId } : {}),
    ...(input.renderMetrics ? { render_metrics: input.renderMetrics as unknown as JsonObject } : {}),
    client_event_id: rendererEventId([input.streamId, input.assignmentId, input.assignmentGeneration, input.sequence, input.storyBlockId, input.groupId, 'group_finished']),
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
  if (response.status !== expected) {
    const text = await response.text();
    let detail = '';
    try {
      const body = JSON.parse(text) as { detail?: unknown };
      if (typeof body.detail === 'string' && body.detail) detail = `: ${body.detail.slice(0, 300)}`;
      // A structured refusal carries the reason the creator needs to see, not just a status.
      const refusal = storyStartRefusalMessage(body);
      if (refusal) detail = `: ${refusal}`;
    } catch {
      // Preserve the bounded status-only error when the response is not JSON.
    }
    throw new Error(`${label} failed with HTTP ${response.status}${detail}`);
  }
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

export function rendererWebSocketUrl(config: Pick<ExternalRendererRunConfig, 'baseUrl'>, advertised: unknown): string {
  const raw = requiredString(advertised, 'websocket_url');
  const url = new URL(raw);
  if (url.search) throw new Error('renderer websocket_url must be query-free');
  const service = new URL(config.baseUrl);
  const localService = service.protocol === 'http:' && LOOPBACK_HOSTS.includes(service.hostname);
  if (localService && url.hostname.endsWith('.local')) {
    url.protocol = 'ws:';
    url.hostname = service.hostname;
    url.port = service.port;
  } else if (localService && url.protocol === 'wss:' && LOOPBACK_HOSTS.includes(url.hostname)) {
    // A local stack advertises its self-signed TLS front, whose cert no client trusts.
    // Its plain bridge port is unknown here, so keep the advertised port and let an
    // explicit handoff services.rendererWebsocketUrl override this best-effort guess.
    url.protocol = 'ws:';
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

interface CompletionLatch { promise: Promise<void>; resolve(): void }
function completionLatch(): CompletionLatch {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
interface PreparedFrame {
  frame: DssFrame;
  groups: ReadonlyArray<{
    group: DssGroup;
    plan: PlannedGroup;
    completed: CompletionLatch;
    shots: ReadonlyArray<{ shot: PlannedShot; job: ScheduledShot<GeneratedShot>; position: number; enqueued: CompletionLatch; record: RendererClipRecord }>;
  }>;
}

class ExternalRendererRun {
  readonly runId = randomUUID();
  readonly status: ExternalRendererRunStatus;
  private socket: WebSocket | null = null;
  private playout: ExternalPlayoutSession | null = null;
  /** The most recent clip whose output-timeline placement is known; decides whether a gap is line- or block-level. */
  private lastPlacedClip: { storyBlockId: string; position: number } | null = null;
  /** Timed-control seconds owed to the audience before the next clip that reaches the playout. */
  private pendingLeadInSeconds = 0;
  private stopped = false;
  private ending = false;
  private closing: Promise<void> | null = null;
  private clipPosition = 0;
  private readonly sceneContext: string[] = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private verdictWatch: NodeJS.Timeout | null = null;
  private readonly seenDss = new Set<string>();
  private readonly startedBlocks = new Set<string>();
  private readonly unplayedDss = new Set<string>();
  private readonly verdicts = new RendererEventVerdicts();
  private readonly abortController = new AbortController();
  private readonly shotPlanner: DssShotPlanner;
  private readonly scheduler: ShotScheduler<GeneratedShot>;
  private readonly generator: ShotGenerator;
  private readonly scenePositions = new Map<number, string>();
  private readonly assetIdentities = new Map<string, string>();
  private readonly sceneAssets = new MinimaxSceneAssetCache({
    uploader: process.env.FAL_KEY && sceneAssetTransport() === 'storage' ? falReferenceUploader(process.env.FAL_KEY) : null,
    downscale: process.env.FAL_KEY && sceneAssetTransport() === 'storage' ? ffmpegReferenceDownscaler() : null,
  });
  private assignmentKey: string | null = null;
  private readonly pendingAudienceMessages = new Map<
    string,
    { resolve: (value: AudienceChatMessageResult) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >();

  constructor(
    private readonly config: ExternalRendererRunConfig,
    private readonly playoutManager: ExternalPlayoutManager,
    private readonly provider: VideoProvider,
    private readonly fakeFailureAfterClips: number | null,
    private readonly consumeFakeFailure: () => void,
  ) {
    this.shotPlanner = new DssShotPlanner({ ...config.shotPlanner, initialImageUrl: config.initialImageUrl ?? config.shotPlanner.initialImageUrl, referenceMode: config.renderMode === 'fal-turbo-i2v' ? 'initial-frame' : 'reference', defaultDurationSeconds: config.clipDurationSeconds });
    this.scheduler = new ShotScheduler(config.generationConcurrency, config.maxBufferedSeconds, this.abortController.signal);
    this.generator = new ShotGenerator({
      renderMode: config.renderMode, continuity: config.continuityStrategy, resolution: config.resolution,
      initialImageUrl: config.initialImageUrl, apiKey: provider.apiKey, scheduler: this.scheduler,
      signal: this.abortController.signal, guard: () => this.verdicts.assertHealthy(),
      frameUploader: provider.kind === 'fal' && sceneAssetTransport() === 'storage' ? falReferenceUploader(provider.apiKey) : undefined,
    });
    this.status = {
      runId: this.runId,
      state: 'connecting',
      rendererId: config.rendererId,
      rendererVersion: config.rendererVersion,
      fakeClips: provider.fakeClips,
      startMode: config.startMode,
      storyRunId: null,
      audienceJoinUrl: null,
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
      clips: [],
      anchorsEstablished: 0,
      anchorsReused: 0,
      generationMsPercentiles: null,
      playbackGaps: emptyPlaybackGapSummary(),
      mediaDir: null,
      finalMp4: null,
      hlsUrl: null,
      lastHeartbeatAt: null,
      eventVerdicts: this.verdicts.status,
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
    void this.closeResources({ preservePlayableOutput: this.status.clipsRendered > 0 });
  }

  private async closeResources(options: { preservePlayableOutput?: boolean } = {}): Promise<void> {
    if (!this.closing) {
      this.stopped = true;
      this.abortController.abort(new DOMException('Renderer stopped', 'AbortError'));
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.verdictWatch) clearInterval(this.verdictWatch);
      this.heartbeat = null;
      this.verdictWatch = null;
      for (const pending of this.pendingAudienceMessages.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('The story chat disconnected.'));
      }
      this.pendingAudienceMessages.clear();
      this.closing = Promise.all([
        this.socket ? closeSocket(this.socket) : Promise.resolve(),
        this.scheduler.drain(),
      ]).then(() => undefined);
    }
    const closingPlayout = this.playout && !options.preservePlayableOutput ? this.playout : null;
    const playoutStop = closingPlayout ? this.playoutManager.stop(closingPlayout.sessionId) : Promise.resolve();
    if (closingPlayout) this.playout = null;
    await Promise.all([this.closing, playoutStop]);
    if (closingPlayout) this.recordRetainedMedia(closingPlayout);
  }

  private recordRetainedMedia(playout: ExternalPlayoutSession): void {
    const status = playout.status();
    this.status.mediaDir = status.mediaDir ?? null;
    this.status.finalMp4 = status.finalMp4 ?? null;
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

  private completedEvent(frame: DssFrame, group: DssGroup, durationSeconds: number, records: readonly RendererClipRecord[] = []): JsonObject {
    return createGroupFinishedEvent({
      streamId: this.config.rendererId,
      assignmentId: frame.assignmentId,
      assignmentGeneration: frame.assignmentGeneration,
      sequence: frame.sequence,
      groupId: group.id,
      storyBlockId: frame.storyBlockId,
      durationSeconds,
      episodeId: frame.episodeId,
      renderMetrics: groupRenderMetrics(records, this.provider.kind === 'minimax-direct' ? 'minimax-direct' : 'fal'),
    });
  }

  private sendRendererEvent(event: JsonObject, frame: DssFrame): void {
    send(this.socket!, this.verdicts.register(event, frame.episodeId));
  }

  private async acknowledgeVerdict(ack: VerdictAcknowledgement): Promise<void> {
    const socket = this.socket!;
    const signal = this.abortController.signal;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
      const onAbort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Renderer verdict ACK write timed out')); }, VERDICT_ACK_TIMEOUT_MS);
      signal.addEventListener('abort', onAbort, { once: true });
      if (socket.readyState !== WebSocket.OPEN) { cleanup(); reject(new Error('Renderer connection closed before verdict ACK')); return; }
      socket.send(JSON.stringify(ack.message), error => { cleanup(); if (error) reject(error); else resolve(); });
    });
    signal.throwIfAborted();
    this.verdicts.acknowledge(ack.message);
    if (ack.failure) throw new Error(ack.failure);
  }

  private async settleFakeFailureVerdicts(): Promise<void> {
    const deadline = Date.now() + FAKE_FAILURE_VERDICT_TIMEOUT_MS;
    while (this.verdicts.status.pending > 0) {
      this.verdicts.assertHealthy();
      if (Date.now() >= deadline) {
        throw new Error(`Synthetic local renderer failure could not settle ${this.verdicts.status.pending} pending verdicts`);
      }
      await waitWithAbort(10, this.abortController.signal);
    }
  }

  /** Resolves once the audience has started seeing `position`, or once it has fully played. */
  private async waitForPlaybackStart(position: number): Promise<void> {
    for (;;) {
      if (this.stopped) throw new Error('renderer run stopped');
      const current = this.playout?.status();
      if (current?.state === 'error') throw new Error(current.error ?? 'playout failed');
      if (current) {
        if (current.playedThroughPosition >= position) return;
        const playout = this.playout as { clipBoundary?: (position: number) => PlayoutClipBoundary | null } | null;
        const boundary = typeof playout?.clipBoundary === 'function' ? playout.clipBoundary(position) : null;
        if (typeof current.audienceSeconds === 'number') {
          // Exact: the clip has been fed and the audience clock has reached its first frame. Any
          // stall or commanded lead-in ahead of it is still "not started", so the kernel's
          // `playing` stamp (and the dashboard's inter-line gap) measure the real dead air.
          if (boundary && current.audienceSeconds + 0.05 >= boundary.startSeconds) return;
        } else if (typeof current.currentPosition === 'number' ? current.currentPosition >= position : current.playedThroughPosition >= position - 1) {
          return;
        }
      }
      await waitWithAbort(250, this.abortController.signal);
    }
  }

  private async waitForPlayback(position: number, frame: DssFrame, group: DssGroup): Promise<void> {
    for (;;) {
      if (this.stopped) throw new Error('renderer run stopped');
      const current = this.playout?.status();
      if (current?.state === 'error') throw new Error(current.error ?? 'playout failed');
      if (current && (current.currentPosition === position || current.playedThroughPosition >= position)) {
        this.assertCurrentAssignment(frame);
        const key = `${frame.assignmentId}:${frame.assignmentGeneration}:${frame.storyBlockId}`;
        if (!this.startedBlocks.has(key)) {
          this.sendRendererEvent(createScriptStartedEvent({
            streamId: this.config.rendererId,
            assignmentId: frame.assignmentId,
            assignmentGeneration: frame.assignmentGeneration,
            sequence: frame.sequence,
            groupId: group.id,
            storyBlockId: frame.storyBlockId,
          }), frame);
          this.startedBlocks.add(key);
        }
      }
      if (current && current.playedThroughPosition >= position) return;
      await waitWithAbort(250, this.abortController.signal);
    }
  }

  private assertCurrentAssignment(frame: DssFrame): void {
    this.abortController.signal.throwIfAborted();
    if (this.assignmentKey !== `${frame.assignmentId}:${frame.assignmentGeneration}`) {
      throw new Error('Renderer assignment changed; start a fresh run');
    }
  }

  private validateSceneContext(frame: DssFrame): void {
    const context = frame.sceneContext;
    if (!context) return;
    for (const image of [context.setImage, ...context.characterImages]) {
      const previous = this.assetIdentities.get(image.assetId);
      const identity = JSON.stringify([image.sourceId, image.characterName ?? null]);
      if (previous && previous !== identity) throw new Error('Certified image asset identity changed');
      this.assetIdentities.set(image.assetId, identity);
    }
    const positions = canonicalJson(context.characterPositions);
    const sceneIndex = frame.sceneIndex ?? -1;
    const previousPositions = this.scenePositions.get(sceneIndex);
    if (previousPositions && previousPositions !== positions) {
      throw new Error('Certified character_positions changed within a scene');
    }
    this.scenePositions.set(sceneIndex, positions);
  }

  private async resolveSceneContext(frame: DssFrame): Promise<void> {
    this.validateSceneContext(frame);
    if (frame.sceneContext) {
      frame.sceneContext = await this.sceneAssets.resolve(frame.sceneContext, this.abortController.signal);
    }
  }

  /** Bounded per-run clip instrumentation: one record per planned shot, in playback order. */
  private trackClip(
    frame: DssFrame,
    shot: Pick<PlannedShot, 'id' | 'groupId' | 'storyBlockId' | 'durationSeconds' | 'anchorKey'>,
    position: number,
    anchor: ClipAnchorRole,
  ): RendererClipRecord {
    const record: RendererClipRecord = {
      shotId: shot.id,
      groupId: shot.groupId,
      storyBlockId: shot.storyBlockId,
      sequence: frame.sequence,
      position,
      durationSeconds: shot.durationSeconds,
      submittedAt: null,
      readyAt: null,
      generationMs: null,
      playedAt: null,
      providerRequestId: null,
      continuity: this.config.continuityStrategy,
      anchor,
      anchorKey: anchor === 'none' ? null : shot.anchorKey,
      streamStartSeconds: null,
      streamEndSeconds: null,
      gapBeforeSeconds: null,
      leadInBeforeSeconds: null,
      gapKind: null,
      falSubmitSeconds: null,
      falQueueSeconds: null,
      falTotalSeconds: null,
      falMaxQueuePosition: null,
    };
    if (anchor === 'establish') this.status.anchorsEstablished += 1;
    else if (anchor === 'reuse') this.status.anchorsReused += 1;
    this.status.clips.push(record);
    this.status.clips.splice(0, Math.max(0, this.status.clips.length - MAX_CLIP_RECORDS));
    return record;
  }

  private playedDuration(record: RendererClipRecord): number {
    return record.streamStartSeconds !== null && record.streamEndSeconds !== null
      ? record.streamEndSeconds - record.streamStartSeconds : record.durationSeconds;
  }

  /**
   * Stamp a clip as played and, when the playout can say where it landed, record the dead air
   * before it. The playout only knows hold seconds once the clip has been fed, which is always
   * before `waitForPlayback` returns, so a null boundary means a playout that does not report them.
   */
  private markPlayed(record: RendererClipRecord): void {
    record.playedAt ??= new Date().toISOString();
    if (record.streamStartSeconds !== null) return;
    const playout = this.playout as { clipBoundary?: (position: number) => PlayoutClipBoundary | null } | null;
    const boundary = typeof playout?.clipBoundary === 'function' ? playout.clipBoundary(record.position) : null;
    if (!boundary) return;
    record.streamStartSeconds = boundary.startSeconds;
    record.streamEndSeconds = boundary.endSeconds;
    record.gapBeforeSeconds = boundary.holdSecondsBefore;
    record.leadInBeforeSeconds = boundary.leadInSecondsBefore ?? 0;
    const previous = this.lastPlacedClip;
    record.gapKind = previous === null ? 'start' : previous.storyBlockId === record.storyBlockId ? 'line' : 'block';
    this.lastPlacedClip = { storyBlockId: record.storyBlockId, position: record.position };
    const gaps = this.status.playbackGaps;
    gaps.clipsPlaced += 1;
    if (boundary.holdSecondsBefore <= 0) return;
    if (record.gapKind === 'line') {
      gaps.lineGapCount += 1;
      gaps.lineGapSeconds += boundary.holdSecondsBefore;
      gaps.maxLineGapSeconds = Math.max(gaps.maxLineGapSeconds, boundary.holdSecondsBefore);
    } else if (record.gapKind === 'block') {
      gaps.blockGapCount += 1;
      gaps.blockGapSeconds += boundary.holdSecondsBefore;
      gaps.maxBlockGapSeconds = Math.max(gaps.maxBlockGapSeconds, boundary.holdSecondsBefore);
    }
  }

  private completeClip(
    record: RendererClipRecord,
    requestId: unknown,
    timings?: { submitSeconds?: number; queueSeconds?: number; totalSeconds?: number; maxQueuePosition?: number | null } | null,
  ): void {
    const readyAt = Date.now();
    record.readyAt = new Date(readyAt).toISOString();
    record.generationMs = record.submittedAt === null ? null : readyAt - Date.parse(record.submittedAt);
    if (typeof requestId === 'string' && requestId) record.providerRequestId = requestId;
    if (timings) {
      record.falSubmitSeconds = typeof timings.submitSeconds === 'number' ? Math.round(timings.submitSeconds * 10) / 10 : null;
      record.falQueueSeconds = typeof timings.queueSeconds === 'number' ? Math.round(timings.queueSeconds * 10) / 10 : null;
      record.falTotalSeconds = typeof timings.totalSeconds === 'number' ? Math.round(timings.totalSeconds * 10) / 10 : null;
      record.falMaxQueuePosition = typeof timings.maxQueuePosition === 'number' ? timings.maxQueuePosition : null;
    }
    this.status.generationMsPercentiles = generationMsPercentiles(this.status.clips);
  }

  private scheduleShot(frame: DssFrame, shot: PlannedShot, position: number): { job: ScheduledShot<GeneratedShot>; record: RendererClipRecord } {
    this.assertCurrentAssignment(frame);
    const dependency = this.generator.describe(shot);
    const record = this.trackClip(frame, shot, position, this.config.continuityStrategy !== 'camera-anchors' ? 'none'
      : dependency.kind === 'anchor-reuse' ? 'reuse' : 'establish');
    let submitted = false;
    const { job } = this.generator.schedule(shot, () => {
      this.assertCurrentAssignment(frame);
      // The generator guards repeatedly; the first call is the run's own submission point.
      if (!submitted) { submitted = true; record.submittedAt = new Date().toISOString(); }
    });
    // Registered at schedule time so it settles before any consumer's own await of the same result.
    void job.result.then(
      generated => this.completeClip(record, generated.requestId, generated.timings ?? null),
      // A future shot can fail while an earlier clip is playing. Fence the whole run
      // immediately, before another scheduler slot submits additional paid work.
      error => {
        if (this.stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        this.fail(new Error(`shot ${shot.id} (seq ${frame.sequence}, clip ${position}) failed: ${message}`, { cause: error }));
      },
    );
    return { job, record };
  }

  private preparePlannedFrame(frame: DssFrame): PreparedFrame {
    this.assertCurrentAssignment(frame);
    this.shotPlanner.applySceneContext(frame.sceneContext ?? null, frame.sceneIndex);
    // Compile the entire accepted frame before submitting any of its paid work.
    const groups = frame.groups.map(group => ({ group, plan: this.shotPlanner.planGroup(group.commands, group.id, frame.storyBlockId) }));
    for (const { plan } of groups) for (const shot of plan.shots) this.generator.validate(shot);
    return { frame, groups: groups.map(({ group, plan }) => ({
      group, plan, completed: completionLatch(), shots: plan.shots.map(shot => {
        const position = this.clipPosition++;
        return { shot, position, ...this.scheduleShot(frame, shot, position), enqueued: completionLatch() };
      }),
    })) };
  }

  private async enqueuePlannedFrame({ frame, groups }: PreparedFrame): Promise<void> {
    for (const { plan, shots } of groups) {
      for (const { shot, job, position, enqueued } of shots) {
        const generated = await job.result;
        this.assertCurrentAssignment(frame);
        // A timed control that preceded this shot is owed to the audience as a pause; the playout
        // holds the previous clip's last frame for it. Handing the clip over now, instead of after
        // that pause has played, keeps normalization and the startup buffer ahead of playback.
        const leadInSeconds = this.pendingLeadInSeconds;
        this.pendingLeadInSeconds = 0;
        this.playout!.enqueue({
          position, storyBlockId: shot.id, videoUrl: generated.videoUrl, durationSeconds: shot.durationSeconds,
          ...(leadInSeconds > 0 ? { leadInSeconds } : {}),
        }, seconds => job.updateDuration(seconds));
        this.status.clipsRendered += 1;
        enqueued.resolve();
      }
      // A timed control follows its group's video and precedes the next group's clip.
      if (plan.delaySeconds > 0) this.pendingLeadInSeconds += plan.delaySeconds;
    }
  }

  private async playPlannedFrame({ frame, groups }: PreparedFrame): Promise<void> {
    for (const { group, plan, shots, completed } of groups) {
      this.assertCurrentAssignment(frame);
      let seconds = 0;
      // Only actual playback advances the kernel high-water mark and frees paid-work budget.
      let announced = false;
      for (const { shot, job, position, enqueued, record } of shots) {
        await abortable(enqueued.promise, this.abortController.signal);
        if (!announced) {
          // The kernel derives "playing" (and the admin dashboard its inter-line gap marker) from
          // this progress report; group_finished alone only says when a line ended.
          await this.waitForPlaybackStart(position);
          this.assertCurrentAssignment(frame);
          this.sendRendererEvent(this.progressEvent(frame, group, 0, group.commands.length), frame);
          announced = true;
        }
        await this.waitForPlayback(position, frame, group);
        this.markPlayed(record);
        this.assertCurrentAssignment(frame);
        job.release();
        seconds += this.playedDuration(record);
      }
      const delay = plan.delaySeconds;
      if (delay > 0) await waitWithAbort(delay * 1_000, this.abortController.signal);
      this.assertCurrentAssignment(frame);
      this.sendRendererEvent(this.completedEvent(frame, group, seconds + delay, shots.map(({ record }) => record)), frame);
      this.status.dssCommandsRendered += group.commands.length;
      completed.resolve();
    }
    this.status.firstDssAcknowledgedAt ??= new Date().toISOString();
    this.unplayedDss.delete(`${frame.assignmentId}:${frame.assignmentGeneration}:${frame.sequence}`);
  }

  private acceptFrame(frame: DssFrame): boolean {
    this.assignmentKey ??= `${frame.assignmentId}:${frame.assignmentGeneration}`;
    this.assertCurrentAssignment(frame);
    const dedupeKey = `${frame.assignmentId}:${frame.assignmentGeneration}:${frame.sequence}`;
    if (this.seenDss.has(dedupeKey)) return false;
    this.seenDss.add(dedupeKey);
    this.status.firstAssignmentAt ??= new Date().toISOString();
    this.status.dssSequences.push(frame.sequence);
    return true;
  }

  private async renderFrame(frame: DssFrame): Promise<void> {
    if (!this.acceptFrame(frame)) return;
    await this.resolveSceneContext(frame);
    const groupsWithCommands = frame.groups.filter((group) => group.commands.length > 0);
    if (groupsWithCommands.length === 0) {
      frame.groups.forEach((group) => this.sendRendererEvent(this.completedEvent(frame, group, 0), frame));
      this.status.firstDssAcknowledgedAt ??= new Date().toISOString();
      return;
    }
    for (const group of frame.groups) {
      if (group.commands.length === 0) {
        this.sendRendererEvent(this.completedEvent(frame, group, 0), frame);
        continue;
      }
      const certifiedContext = frame.sceneContext ? sceneContextPrompt(frame.sceneContext) : null;
      const planned = planGroupClips(
        frame,
        group,
        this.config.clipDurationSeconds,
        certifiedContext ? [...this.sceneContext, certifiedContext] : this.sceneContext,
      );
      if (planned.length === 0) {
        const controlDuration = controlGroupDurationSeconds(group);
        if (controlDuration === null) throw new Error(`DSS group ${group.id} contains no supported renderable commands`);
        if (controlDuration > 0) await abortable(
          new Promise((resolve) => setTimeout(resolve, controlDuration * 1_000)), this.abortController.signal,
        );
        if (this.stopped) throw this.abortController.signal.reason;
        this.sendRendererEvent(this.completedEvent(frame, group, controlDuration), frame);
        this.status.dssCommandsRendered += group.commands.length;
        continue;
      }
      this.sendRendererEvent(this.progressEvent(frame, group, 0, group.commands.length), frame);
      let playedSeconds = 0;
      for (const clip of planned) {
        if (this.stopped) throw this.abortController.signal.reason;
        this.verdicts.assertHealthy();
        const position = this.clipPosition;
        const record = this.trackClip(
          frame,
          { id: `${clip.groupId}:${position}`, groupId: clip.groupId, storyBlockId: clip.storyBlockId, durationSeconds: clip.durationSeconds, anchorKey: '' },
          position,
          'none',
        );
        record.submittedAt = new Date().toISOString();
        const input = {
          prompt: clip.prompt,
          duration: clip.durationSeconds,
          resolution: this.config.resolution,
          aspectRatio: '16:9' as const,
          ...(frame.sceneContext ? { referenceImageUrls: sceneContextImageUrls(frame.sceneContext) } : {}),
        };
        if (this.provider.fakeClips && this.fakeFailureAfterClips !== null && position >= this.fakeFailureAfterClips) {
          // Exercise cleanup without manufacturing a poison cancel record: the
          // platform must commit verdicts for the completed synthetic clips
          // before this local-only failure closes the renderer connection.
          await this.settleFakeFailureVerdicts();
          this.consumeFakeFailure();
          throw new Error(`Synthetic local renderer failure after ${this.fakeFailureAfterClips} fake clips`);
        }
        const generated = this.provider.fakeClips
          ? {
              requestId: `fake-${this.runId}-${position}`,
              videoUrl: `fake://pickford-clips/${this.runId}/${position}`,
              expandedPrompt: null,
              generationMode: 'text' as const,
              timings: { submitSeconds: 0, queueSeconds: 0, totalSeconds: 0, polls: 0 },
            }
          : this.provider.kind === 'minimax-direct'
          ? await generateMiniMaxVideo(input, {
              apiKey: this.provider.apiKey,
              baseUrl: process.env.MINIMAX_API_BASE_URL,
              textModel: process.env.MINIMAX_VIDEO_MODEL_ID,
              referenceModel: process.env.MINIMAX_REFERENCE_VIDEO_MODEL_ID,
              timeoutMs: defaultRequestTimeoutMs(),
              signal: this.abortController.signal,
            })
          : await generateVideo(input, {
              apiKey: this.provider.apiKey,
              modelId: process.env.FAL_VIDEO_MODEL_ID,
              queueBaseUrl: process.env.FAL_QUEUE_BASE_URL,
              timeoutMs: defaultRequestTimeoutMs(),
              signal: this.abortController.signal,
            });
        if (this.stopped) throw this.abortController.signal.reason;
        this.completeClip(record, generated.requestId, generated.timings ?? null);
        this.playout!.enqueue({
          position,
          storyBlockId: clip.storyBlockId,
          videoUrl: generated.videoUrl,
          durationSeconds: clip.durationSeconds,
        });
        this.clipPosition += 1;
        this.status.clipsRendered += 1;
        await this.waitForPlayback(position, frame, group);
        this.markPlayed(record);
        playedSeconds += this.playedDuration(record);
      }
      this.sendRendererEvent(this.completedEvent(frame, group, playedSeconds), frame);
      this.status.dssCommandsRendered += group.commands.length;
    }
    this.status.firstDssAcknowledgedAt ??= new Date().toISOString();
  }

  private async observeStoryLifecycle(): Promise<void> {
    if (!this.config.storyStatusBaseUrl || !this.config.storyStatusToken || this.status.storyId === null) return;
    let observedRunning = false;
    while (!this.stopped) {
      const response = await fetch(`${this.config.storyStatusBaseUrl}/story/?id=${this.status.storyId}`, {
        headers: { Authorization: `Bearer ${this.config.storyStatusToken}` },
        signal: this.abortController.signal,
      });
      const payload = await jsonResponse(response, 'story lifecycle read', 200);
      const observation = classifyStoryLifecycle(payload, observedRunning, this.status.firstAssignmentAt !== null);
      observedRunning = observation.observedRunning;
      if (observation.state === 'failed') {
        throw new Error(`Story ${this.status.storyId} failed: ${observation.failure}`);
      }
      if (observation.state === 'ended') {
        this.status.storyEndedAt = new Date().toISOString();
        this.ending = true;
        // Finish only already-received work under its existing generation/playout
        // cancellation fences. A short verdict deadline must never truncate video.
        while (this.unplayedDss.size > 0) await waitWithAbort(25, this.abortController.signal);
        const deadline = Date.now() + NATURAL_COMPLETION_DRAIN_MS;
        while (this.verdicts.status.pending > 0) {
          if (Date.now() >= deadline) throw new Error(`Story ended with ${this.verdicts.status.pending} renderer verdicts pending`);
          await waitWithAbort(25, this.abortController.signal);
        }
        this.abortController.signal.throwIfAborted();
        this.status.state = 'ended';
        await this.closeResources();
        return;
      }
      await abortable(new Promise((resolve) => setTimeout(resolve, 1_000)), this.abortController.signal);
    }
  }

  async submitAudienceMessage(input: AudienceChatMessageInput): Promise<AudienceChatMessageResult> {
    if (this.stopped || this.status.state !== 'running' || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('The story chat is not connected yet.');
    }
    const storyId = this.status.storyId;
    if (storyId === null) throw new Error('The story identity is not resolved yet.');
    if (this.pendingAudienceMessages.has(input.idempotencyKey)) {
      throw new Error('That message is already being sent.');
    }
    return await new Promise<AudienceChatMessageResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAudienceMessages.delete(input.idempotencyKey);
        reject(new Error('The story chat did not acknowledge the message.'));
      }, 10_000);
      this.pendingAudienceMessages.set(input.idempotencyKey, { resolve, reject, timeout });
      try {
        send(this.socket!, createRendererAudienceMessage(storyId, input));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingAudienceMessages.delete(input.idempotencyKey);
        reject(error instanceof Error ? error : new Error('The story chat could not send the message.'));
      }
    });
  }

  private resolveAudienceMessage(message: JsonObject): boolean {
    const parsed = parseRendererAudienceResult(message);
    if (!parsed) return false;
    const pending = this.pendingAudienceMessages.get(parsed.key);
    if (!pending) return true;
    clearTimeout(pending.timeout);
    this.pendingAudienceMessages.delete(parsed.key);
    pending.resolve(parsed.result);
    return true;
  }

  async start(): Promise<void> {
    try {
      // Hold the stream until the first two clips are rendered: with the first two shots generating
      // independently they land together, and the audience never sees a freeze after line one.
      const playout = await this.playoutManager.start({ startupBufferClips: STARTUP_BUFFER_CLIPS, startupWaitMs: STARTUP_WAIT_MS });
      if (this.stopped) { await this.playoutManager.stop(playout.sessionId); return; }
      this.playout = playout;
      this.status.hlsUrl = this.playout.hlsUrl;
      this.status.mediaDir = playout.status().mediaDir ?? null;
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
        renderer_kind: this.provider.kind === 'minimax-direct' || this.config.renderMode === 'fal-max-ref2v' ? 'minimax-h3-max' : 'minimax-h3-max-turbo',
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
      this.socket.on('close', (code, reason) => {
        // The platform puts its protocol-error text in the close reason; without it a 4400 is undiagnosable.
        const detail = reason?.length ? `: ${reason.toString()}` : '';
        if (!this.stopped) this.fail(new Error(`renderer WebSocket closed (${code}${detail})`));
      });
      const leaseSeconds = Number(welcome.lease_seconds ?? 30);
      this.heartbeat = setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) send(this.socket, { type: 'renderer.heartbeat' });
      }, Math.max(1_000, Math.floor(leaseSeconds * 1_000 / 4)));
      if (this.config.registerManifest) {
        const assetJson = assetManifestFor(this.config, this.provider.kind);
        const sha256 = assetManifestSha256(assetJson);
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
        const startPayload = await requestStoryStart({
          url: `${this.config.baseUrl}/api/v1/renderers/start-story`,
          accessToken,
          signal: this.abortController.signal,
          body: this.storyStartBody(),
          retryAmbiguous: this.config.startMode === 'opaque',
          onResponse: (status) => { this.status.storyStartStatus = status; },
          readResponse: (response) => jsonResponse(response, 'renderer story start', 202),
          afterAccepted: this.config.startMode === 'opaque'
            ? async (payload, recoverySignal) => {
              this.acceptOpaqueStart(payload);
              await this.resolveOpaqueStoryIdentity(recoverySignal);
            }
            : undefined,
        });
        if (this.stopped) return;
        if (this.config.startMode !== 'opaque' && startPayload.renderer_id !== undefined && startPayload.renderer_id !== this.config.rendererId) {
          throw new Error('renderer story start returned a mismatched renderer ID');
        }
      }
      if (this.stopped) return;
      this.status.state = 'running';
      this.verdictWatch = setInterval(() => {
        try { this.verdicts.assertHealthy(); }
        catch (error) { if (!this.stopped) this.fail(error); }
      }, 1_000);
      void this.observeStoryLifecycle().catch((error) => {
        if (!this.stopped) this.fail(error);
      });
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Renderer connection closed');
      const dssMessages = new AsyncJsonQueue(MAX_PENDING_DSS_FRAMES);
      const receiver = (async () => {
        while (!this.stopped && this.socket?.readyState === WebSocket.OPEN) {
          const message = await opened.messages.next(300_000, this.abortController.signal);
          if (message.type === 'websocket.closed') break;
          if (message.type === 'renderer.heartbeat.accepted') {
            this.status.lastHeartbeatAt = new Date().toISOString();
            continue;
          }
          if (this.resolveAudienceMessage(message)) continue;
          if (message.type === 'renderer.event.verdict') {
            const ack = this.verdicts.receiveVerdict(message, this.assignmentKey);
            if (ack) await this.acknowledgeVerdict(ack);
            continue;
          }
          if (message.type === 'renderer.event.rejected') {
            const failure = this.verdicts.receiveRejection(message);
            if (failure) throw new Error(failure);
            continue;
          }
          if (message.script) {
            if (this.ending) continue;
            const frame = parseDssFrame(message);
            this.adoptAssignedStory(frame);
            if (this.config.renderMode !== 'auto') {
              if (message.stream_id !== this.config.rendererId) throw new Error('DSS command targeted another renderer');
              if (!frame.assignmentId || !Number.isInteger(frame.assignmentGeneration) || frame.assignmentGeneration < 1) throw new Error('DSS assignment identity is required');
              const key = `${frame.assignmentId}:${frame.assignmentGeneration}`;
              if (this.assignmentKey && this.assignmentKey !== key) throw new Error('Renderer assignment changed; start a fresh run');
              this.assignmentKey = key;
            }
            const dedupeKey = `${frame.assignmentId}:${frame.assignmentGeneration}:${frame.sequence}`;
            if (!this.seenDss.has(dedupeKey)) this.unplayedDss.add(dedupeKey);
            dssMessages.push(message);
          }
        }
        if (!this.stopped) throw new Error('Renderer connection closed');
      })().catch(error => {
        if (!this.stopped) this.fail(error);
      });
      if (this.config.renderMode !== 'auto') {
        const prepared = new PreparedFrameQueue<PreparedFrame>(MAX_PREPARED_DSS_FRAMES, this.abortController.signal);
        const queued = new PreparedFrameQueue<{ value: PreparedFrame; release(): void }>(MAX_PREPARED_DSS_FRAMES, this.abortController.signal);
        const planner = (async () => {
          while (!this.stopped) {
            const waitController = new AbortController();
            const waitSignal = AbortSignal.any([this.abortController.signal, waitController.signal]);
            // ACK-gated kernels may legitimately deliver no next DSS throughout
            // generation and playback. Their idle timeout starts after real ACKs.
            let message: JsonObject;
            try {
              if (!this.status.firstAssignmentAt) {
                message = await dssMessages.next(null, waitSignal);
              } else {
                const idleTimeout = (async () => {
                  await prepared.waitForIdle(waitSignal);
                  await waitWithAbort(DSS_IDLE_TIMEOUT_MS, waitSignal);
                  throw new Error('timed out waiting for DSS after playback became idle');
                })();
                message = await Promise.race([dssMessages.next(null, waitSignal), idleTimeout]);
              }
            }
            finally { waitController.abort(); }
            const frame = parseDssFrame(message);
            if (this.acceptFrame(frame)) {
              await this.resolveSceneContext(frame);
              await prepared.prepare(() => this.preparePlannedFrame(frame));
            }
          }
        })();
        const feeder = (async () => {
          while (!this.stopped) {
            const item = await prepared.next();
            // Publish to the ACK consumer before feeding: it must be able to free
            // budget even when this payload contains more video than the budget.
            await queued.prepare(() => item);
            await this.enqueuePlannedFrame(item.value);
          }
        })();
        const playback = (async () => {
          while (!this.stopped) {
            const item = await queued.next();
            await this.playPlannedFrame(item.value.value);
            item.value.release();
            item.release();
          }
        })();
        await Promise.all([receiver, planner, feeder, playback]);
        return;
      }
      while (!this.stopped && this.socket.readyState === WebSocket.OPEN) {
        const message = await dssMessages.next(
          this.status.firstAssignmentAt ? DSS_IDLE_TIMEOUT_MS : null,
          this.abortController.signal,
        );
        if (message.type === 'websocket.closed') break;
        if (message.stream_id !== this.config.rendererId) throw new Error('DSS command targeted another renderer');
        const frame = parseDssFrame(message);
        await this.renderFrame(frame);
        this.unplayedDss.delete(`${frame.assignmentId}:${frame.assignmentGeneration}:${frame.sequence}`);
      }
      await receiver;
    } catch (error) {
      if (!this.stopped) this.fail(error);
    }
  }

  private storyStartBody(): JsonObject {
    if (this.config.startMode === 'legacy') {
      return {
        renderer_id: this.config.rendererId,
        story_id: this.config.storyId,
        room_id: this.config.roomId,
        idempotency_key: `video-renderer:${this.config.rendererId}:${this.config.storyId}`,
      };
    }
    // The kernel replays a start under a reused key, so the per-run nonce makes each start of an EVD a new story.
    return {
      evd_id: this.config.evdId,
      idempotency_key: `video-renderer:${this.config.rendererId}:${this.config.evdId}:${this.runId}`,
      ...(this.config.supersedeExistingStory ? { supersede_existing: true } : {}),
    };
  }

  private acceptOpaqueStart(payload: JsonObject): void {
    if (payload.status !== 'audience_ready') throw new Error('renderer story start did not commit audience readiness');
    this.status.storyRunId = uuid(payload.story_run_id, 'story_run_id');
    this.status.audienceJoinUrl = requiredString(payload.audience_join_url, 'audience_join_url');
    // PIC-1739 names the story in the start response. Adopt it immediately so the creator sees the
    // identity without waiting on the audience exchange, which then only has to agree.
    if (payload.story_id !== undefined) this.status.storyId = positiveInteger(payload.story_id, Number.NaN, 'story_id');
    if (typeof payload.room_shortlink === 'string' && payload.room_shortlink) {
      this.status.roomShortlink = payload.room_shortlink;
    }
  }

  // The opaque start hides the platform story; the audience exchange is the public route that names it.
  private async resolveOpaqueStoryIdentity(recoverySignal: AbortSignal): Promise<void> {
    const joinUrl = new URL(requiredString(this.status.audienceJoinUrl, 'audience_join_url'));
    const segments = joinUrl.pathname.split('/').filter(Boolean);
    if (!['http:', 'https:'].includes(joinUrl.protocol) || segments.length !== 2 || segments[0] !== 'audience') {
      throw new Error('renderer story start returned an invalid audience join URL');
    }
    const exchangeUrl = this.config.audienceExchangeUrl ?? `${this.config.baseUrl}${AUDIENCE_EXCHANGE_PATH}`;
    const body = JSON.stringify({ opaque_handle: segments[1] });
    const result = await requestTransientDependency({
      signal: recoverySignal,
      request: () => fetch(exchangeUrl, {
        method: 'POST',
        headers: { Origin: joinUrl.origin, 'Content-Type': 'application/json' },
        signal: recoverySignal,
        body,
      }),
      readResponse: async (response) => {
        if (response.status !== 200) {
          await response.body?.cancel();
          // Do not include a downstream response body: it could echo the opaque handle.
          throw new Error(`audience exchange failed with HTTP ${response.status}`);
        }
        return asObject(await response.json(), 'audience exchange');
      },
      onRetry: (reason) => this.logAudienceExchangeRetry(reason),
    });
    const session = asObject(result.session, 'audience exchange session');
    const exchanged = positiveInteger(session.story_id, Number.NaN, 'audience exchange story_id');
    if (this.status.storyId !== null && this.status.storyId !== exchanged) {
      throw new Error('audience exchange named a different story than the start response');
    }
    this.status.storyId = exchanged;
    if (session.message_channel_id !== undefined) {
      this.status.storyMessageChannelId = uuid(session.message_channel_id, 'audience exchange message_channel_id');
    }
  }

  private logAudienceExchangeRetry(reason: TransientDependencyRetry): void {
    const cause = reason.kind === 'http'
      ? `HTTP ${reason.status}`
      : `transport ${reason.errorName}`;
    // Keep diagnostics status/class-only: audience handles and credentials are never safe to log.
    console.warn(`Audience exchange ${cause}; retrying within the story start recovery window.`);
  }

  private adoptAssignedStory(frame: DssFrame): void {
    if (this.config.startMode !== 'opaque' || frame.episodeId === undefined || frame.episodeId <= 0) return;
    if (this.status.storyId === null) this.status.storyId = frame.episodeId;
    else if (this.status.storyId !== frame.episodeId) throw new Error('DSS command targeted another story');
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
  private fakeFailureArmed: boolean;

  constructor(
    private readonly playoutManager: ExternalPlayoutManager,
    private readonly options: { fakeClips?: boolean; fakeFailureAfterClips?: number | null } = {},
  ) {
    this.fakeFailureArmed = options.fakeFailureAfterClips !== null && options.fakeFailureAfterClips !== undefined;
  }

  start(value: unknown): ExternalRendererRunStatus {
    if ([...this.runs.values()].some(run => ['connecting', 'running'].includes(run.status.state))) {
      throw new Error('A renderer run is already active. Stop it before starting another.');
    }
    for (const [id, run] of this.runs) {
      if (['stopped', 'failed', 'ended'].includes(run.status.state)) this.runs.delete(id);
    }
    const config = parseExternalRendererRunConfig(value);
    if (this.options.fakeClips) {
      const hostname = new URL(config.baseUrl).hostname;
      const localHost = ['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(hostname);
      // Local unified stacks identify their Renderer Platform tier as `dev` even
      // though the service itself is bound to loopback. The loopback boundary is
      // the safety fence; environment alone is not a reliable locality signal.
      if (!localHost || !LOOPBACK_PLAINTEXT_ENVIRONMENTS.has(config.environment)) {
        throw new Error('PICKFORD_FAKE_CLIPS is restricted to a loopback local renderer run');
      }
      if (config.renderMode !== 'auto') throw new Error('PICKFORD_FAKE_CLIPS supports only the auto MiniMax adapter');
    }
    const minimaxKey = process.env.MINIMAX_API_KEY;
    const falKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
    const provider: VideoProvider | null = this.options.fakeClips
      ? { kind: 'minimax-direct', apiKey: '', fakeClips: true }
      : config.renderMode !== 'auto'
      ? falKey ? { kind: 'fal', apiKey: falKey, fakeClips: false } : null
      : minimaxKey
      ? { kind: 'minimax-direct', apiKey: minimaxKey, fakeClips: false }
      : falKey ? { kind: 'fal', apiKey: falKey, fakeClips: false } : null;
    if (!provider) throw new Error(config.renderMode === 'auto' ? 'MINIMAX_API_KEY or FAL_KEY is not configured on the renderer server' : 'Explicit fal rendering requires FAL_KEY; no provider fallback is used');
    const fakeFailureAfterClips = provider.fakeClips && this.fakeFailureArmed
      ? this.options.fakeFailureAfterClips ?? null
      : null;
    const run = new ExternalRendererRun(
      config,
      this.playoutManager,
      provider,
      fakeFailureAfterClips,
      () => { this.fakeFailureArmed = false; },
    );
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
      rendererConfig: prepared.rendererConfig,
      renderMode: prepared.renderMode, initialImageUrl: prepared.initialImageUrl,
      generationConcurrency: prepared.generationConcurrency, maxBufferedSeconds: prepared.maxBufferedSeconds,
      shotPlanner: prepared.shotPlanner,
      includeDialogueAudioReferences: prepared.includeDialogueAudioReferences,
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

  latest(): ExternalRendererRunStatus | null {
    return [...this.runs.values()].at(-1)?.status ?? null;
  }

  async submitAudienceMessage(input: AudienceChatMessageInput): Promise<AudienceChatMessageResult> {
    const run = [...this.runs.values()].at(-1);
    if (!run) throw new Error('There is no active story.');
    return await run.submitAudienceMessage(input);
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
