import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AudienceChatMessageInput, ExternalRendererRunManager } from './external-renderer.js';

const MAX_BODY_BYTES = 8_192;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function publicOrigin(request: IncomingMessage, env: NodeJS.ProcessEnv): string | null {
  const configured = env.PUBLIC_APP_URL || env.RENDER_EXTERNAL_URL || (env.FLY_APP_NAME ? `https://${env.FLY_APP_NAME}.fly.dev` : undefined);
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return null;
    }
  }
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return null;
  return `http://${host}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('Message request is too large.');
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Message request must be an object.');
  return value as JsonObject;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer.`);
  return text;
}

export class AudienceChatGateway {
  private readonly csrfToken = randomBytes(32).toString('base64url');
  private fencedRunId: string | null = null;

  constructor(
    private readonly runs: ExternalRendererRunManager,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const pathname = new URL(request.url ?? '/', 'http://local').pathname;
    if (pathname === '/api/audience-chat/session' && request.method === 'GET') {
      const run = this.runs.latest();
      const ready = run?.state === 'running'
        && run.storyStartStatus === 202
        && typeof run.hlsUrl === 'string'
        && run.runId !== this.fencedRunId;
      sendJson(response, 200, {
        ready,
        csrfToken: ready ? this.csrfToken : null,
        limits: { displayName: MAX_DISPLAY_NAME_LENGTH, message: MAX_MESSAGE_LENGTH },
      });
      return true;
    }
    if (pathname !== '/api/audience-chat/messages') return false;
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method not allowed' });
      return true;
    }
    const expectedOrigin = publicOrigin(request, this.env);
    const origin = request.headers.origin;
    if (!expectedOrigin || typeof origin !== 'string' || origin !== expectedOrigin) {
      sendJson(response, 403, { error: 'This message did not come from the story viewer.' });
      return true;
    }
    const csrf = request.headers['x-csrf-token'];
    if (typeof csrf !== 'string' || !safeEqual(csrf, this.csrfToken)) {
      sendJson(response, 403, { error: 'Refresh the story viewer before sending a message.' });
      return true;
    }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      sendJson(response, 415, { error: 'Message requests must use JSON.' });
      return true;
    }
    let input: AudienceChatMessageInput;
    try {
      const body = await readJson(request);
      const viewerId = boundedText(body.viewerId, 'Viewer identity', 36);
      const idempotencyKey = boundedText(body.idempotencyKey, 'Message identity', 36);
      if (!UUID_PATTERN.test(viewerId) || !UUID_PATTERN.test(idempotencyKey)) throw new Error('Refresh the story viewer before sending a message.');
      input = {
        externalSubject: `viewer:${viewerId}`,
        idempotencyKey,
        displayName: boundedText(body.displayName, 'Display name', MAX_DISPLAY_NAME_LENGTH),
        content: boundedText(body.content, 'Message', MAX_MESSAGE_LENGTH),
      };
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'The message request is invalid.' });
      return true;
    }
    try {
      const runId = this.runs.latest()?.runId;
      if (runId && runId === this.fencedRunId) {
        sendJson(response, 410, { error: 'This story is no longer accepting audience messages.' });
        return true;
      }
      const result = await this.runs.submitAudienceMessage(input);
      if (!result.accepted) {
        if (result.code === 'renderer_fenced') {
          this.fencedRunId = runId ?? null;
          sendJson(response, 410, { error: 'This story is no longer accepting audience messages.' });
          return true;
        }
        sendJson(response, result.code === 'rate_limited' || result.code === 'backpressure' ? 429 : 503, {
          error: result.detail ?? 'The story did not accept the message.',
          retryAfterSeconds: result.retryAfterSeconds,
        });
        return true;
      }
      sendJson(response, 201, { accepted: true, duplicate: result.duplicate ?? false, messageId: result.messageId });
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : 'The message could not be sent.' });
    }
    return true;
  }
}
