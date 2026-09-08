import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { creatorStatus, type CreatorStatus } from './creator-status.js';
import { AUDIENCE_EXCHANGE_PATH, type ExternalRendererRunManager, type ExternalRendererRunStatus } from './external-renderer.js';
import { clearFalKey, falKeyStatus, saveFalKey } from './fal-key.js';
import { CALLBACK_PATH, PickfordAuth } from './pickford-auth.js';
import { pickfordEnvironment, type PickfordEnvironment } from './pickford-environment.js';
import {
  credentialFenced,
  mintRendererCredential,
  readStoredCredential,
  rotateRendererCredential,
  type StoredCredential,
} from './renderer-credential.js';
import { listStoryBundles, type StoryBundle, type StoryBundleAdapter } from './story-bundles.js';

/**
 * The local creator surface behind http://localhost:4174: sign in with Pickford, mint the renderer
 * credential, list StoryBundles, store the fal key, press Play.
 *
 * Boundary rules, in addition to the loopback listener binding:
 *  - every mutation requires the same-origin local page plus this process's CSRF token;
 *  - the OAuth callback is a cross-site top-level navigation by design, so it is authenticated by
 *    the PKCE `state` it carries instead;
 *  - responses carry status only. Tokens, the client secret and the fal key never leave `.renderer/`.
 */

const MAX_BODY_BYTES = 8_192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RENDERER_VERSION = 'h3.opensource.v1.2';

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, status: number, heading: string, detail: string): void {
  const escape = (value: string): string => value.replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="referrer" content="no-referrer" /><title>${escape(heading)} · Pickford</title><style>:root{color-scheme:dark;font-family:system-ui,sans-serif}body{margin:0;padding:12vh 24px;background:#090b10;color:#f4f1eb}main{max-width:520px;margin:auto}h1{font-size:26px;letter-spacing:-.03em}p{color:#b8b9bf;line-height:1.6}</style></head><body><main><h1>${escape(heading)}</h1><p>${escape(detail)}</p></main></body></html>`);
}

export function isSameOriginLocalPage(request: IncomingMessage): boolean {
  try {
    const host = new URL(`http://${request.headers.host ?? ''}`).hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return false;
    if (request.headers['x-forwarded-for'] || request.headers.forwarded) return false;
    if (request.headers['sec-fetch-site'] !== 'same-origin') return false;
    const source = request.headers.origin ?? request.headers.referer;
    if (!source) return true;
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(source).hostname);
  } catch {
    return false;
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('That request was too large.');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('That request was not an object.');
  return value as Record<string, unknown>;
}

export class CreatorApi {
  private readonly csrfToken = randomBytes(32).toString('base64url');
  private readonly environment: PickfordEnvironment;
  private readonly auth: PickfordAuth;
  private bundleAdapter: StoryBundleAdapter | null = null;
  private bundleNotice: string | null = null;
  private startedEvdId: string | null = null;

  constructor(
    private readonly runs: ExternalRendererRunManager,
    private readonly options: {
      env?: NodeJS.ProcessEnv;
      auth?: PickfordAuth;
      environment?: PickfordEnvironment;
      now?: () => number;
      version?: string;
    } = {},
  ) {
    this.environment = options.environment ?? pickfordEnvironment(options.env);
    this.auth = options.auth ?? new PickfordAuth({
      environment: this.environment,
      env: options.env,
      version: options.version,
    });
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private latestRun(): ExternalRendererRunStatus | null {
    return this.runs.latest();
  }

  status(includeCsrf: boolean): CreatorStatus & { bundleNotice: string | null; authNotice: string | null } {
    return {
      ...creatorStatus({
        environment: this.environment.name,
        auth: this.auth.status(),
        credential: readStoredCredential(this.env),
        falKey: falKeyStatus(this.env),
        bundleAdapter: this.bundleAdapter,
        run: this.latestRun(),
        evdId: this.startedEvdId,
        nowMs: this.now(),
        csrfToken: includeCsrf ? this.csrfToken : null,
      }),
      bundleNotice: this.bundleNotice,
      authNotice: this.auth.notice(),
    };
  }

  /** The loopback redirect URI, derived from the port this page is served on. */
  redirectUri(request: IncomingMessage): string {
    const host = request.headers.host ?? `127.0.0.1:${this.env.MEDIA_PORT ?? '4174'}`;
    return `http://${host}${CALLBACK_PATH}`;
  }

  private async ensureCredential(): Promise<StoredCredential> {
    const accessToken = await this.auth.accessToken();
    const existing = readStoredCredential(this.env);
    const run = this.latestRun();
    if (existing && run?.state === 'failed' && credentialFenced(run.failures)) {
      return await rotateRendererCredential({
        bffBaseUrl: this.environment.webBaseUrl,
        accessToken,
        credential: existing,
        env: this.env,
      });
    }
    if (existing) return existing;
    return await mintRendererCredential({
      bffBaseUrl: this.environment.webBaseUrl,
      accessToken,
      environment: this.environment.name,
      env: this.env,
    });
  }

  private async bundles(): Promise<{ bundles: StoryBundle[]; adapter: StoryBundleAdapter; notice: string | null }> {
    const listing = await listStoryBundles({
      bffBaseUrl: this.environment.webBaseUrl,
      apiBaseUrl: this.environment.apiBaseUrl,
      accessToken: await this.auth.accessToken(),
      userId: this.auth.userId(),
    });
    this.bundleAdapter = listing.adapter;
    this.bundleNotice = listing.adapter === 'published-evds' && !listing.ownerFilterApplied
      ? 'Pickford is listing published StoryBundles without an owner filter on this environment, so this list can include StoryBundles you do not own.'
      : null;
    return { bundles: listing.bundles, adapter: listing.adapter, notice: this.bundleNotice };
  }

  private async play(evdId: string): Promise<ExternalRendererRunStatus> {
    if (!UUID.test(evdId)) throw new Error('That StoryBundle id is not valid.');
    if (!falKeyStatus(this.env).present && !this.env.MINIMAX_API_KEY) {
      throw new Error('Add your fal key on this page before starting a StoryBundle.');
    }
    const active = this.latestRun();
    if (active && ['connecting', 'running'].includes(active.state)) {
      throw new Error('A StoryBundle is already playing. Stop it before starting another.');
    }
    const credential = await this.ensureCredential();
    const run = this.runs.start({
      baseUrl: this.environment.webBaseUrl,
      audienceExchangeUrl: `${this.environment.chatBaseUrl}${AUDIENCE_EXCHANGE_PATH}`,
      environment: this.environment.name,
      rendererId: credential.rendererId,
      credentialId: credential.credentialId,
      clientSecret: credential.clientSecret,
      rendererVersion: this.env.STORY_RENDERER_VERSION || RENDERER_VERSION,
      // Renderer-initiated opaque start: Pickford allocates the story and the room from the bundle.
      startMode: 'opaque',
      evdId,
      // The creator picker currently lists MiniMax StoryBundles. Select the reference-to-video
      // pipeline explicitly so playback uses its bounded concurrent scheduler and camera anchors;
      // `auto` is the legacy serial provider path and cannot build enough lookahead to avoid gaps.
      rendererConfig: { model: 'fal-max-ref2v' },
      resolution: this.env.STORY_RESOLUTION || '480P',
      clipDurationSeconds: Number.parseInt(this.env.STORY_CLIP_SECONDS ?? '6', 10),
    });
    this.startedEvdId = evdId;
    return run;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://local');
    const pathname = url.pathname;
    if (pathname === CALLBACK_PATH && request.method === 'GET') {
      await this.handleCallback(url, response);
      return true;
    }
    if (!pathname.startsWith('/api/creator/')) return false;
    if (!isSameOriginLocalPage(request)) {
      sendJson(response, 403, { error: 'This page is only available from the local renderer viewer.' });
      return true;
    }
    if (pathname === '/api/creator/status' && request.method === 'GET') {
      sendJson(response, 200, this.status(true));
      return true;
    }
    if (pathname === '/api/creator/story-bundles' && request.method === 'GET') {
      if (!this.auth.signedIn()) {
        sendJson(response, 401, { error: 'Sign in with Pickford to see your StoryBundles.' });
        return true;
      }
      try {
        sendJson(response, 200, await this.bundles());
      } catch (error) {
        sendJson(response, 502, { error: error instanceof Error ? error.message : 'Pickford could not list your StoryBundles.' });
      }
      return true;
    }
    if (!['POST', 'DELETE'].includes(request.method ?? '')) {
      sendJson(response, 405, { error: 'method not allowed' });
      return true;
    }
    const csrf = request.headers['x-csrf-token'];
    if (typeof csrf !== 'string' || !safeEqual(csrf, this.csrfToken)) {
      sendJson(response, 403, { error: 'Reload the renderer page and try again.' });
      return true;
    }
    try {
      await this.handleMutation(pathname, request, response);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'That request failed.' });
    }
    return true;
  }

  private async handleMutation(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (pathname === '/api/creator/sign-in' && request.method === 'POST') {
      const { authorizationUrl } = await this.auth.beginSignIn(this.redirectUri(request));
      sendJson(response, 200, { authorizationUrl });
      return;
    }
    if (pathname === '/api/creator/sign-out' && request.method === 'POST') {
      await this.auth.signOut();
      this.bundleAdapter = null;
      this.bundleNotice = null;
      sendJson(response, 200, this.status(true));
      return;
    }
    if (pathname === '/api/creator/fal-key' && request.method === 'POST') {
      const body = await readJson(request);
      sendJson(response, 200, { falKey: saveFalKey(body.key, this.env) });
      return;
    }
    if (pathname === '/api/creator/fal-key' && request.method === 'DELETE') {
      sendJson(response, 200, { falKey: clearFalKey(this.env) });
      return;
    }
    if (pathname === '/api/creator/renderer-credential' && request.method === 'POST') {
      const credential = await this.ensureCredential();
      sendJson(response, 200, { credential: { rendererId: credential.rendererId, adapter: credential.adapter } });
      return;
    }
    if (pathname === '/api/creator/play' && request.method === 'POST') {
      const body = await readJson(request);
      const evdId = typeof body.evdId === 'string' ? body.evdId : '';
      const run = await this.play(evdId);
      sendJson(response, 202, {
        runId: run.runId,
        state: run.state,
        storyRunId: run.storyRunId,
        storyId: run.storyId,
        audienceJoinUrl: run.audienceJoinUrl,
      });
      return;
    }
    if (pathname === '/api/creator/stop' && request.method === 'POST') {
      const stopped = await this.runs.stopActive();
      sendJson(response, stopped ? 200 : 404, stopped ?? { error: 'No StoryBundle is playing.' });
      return;
    }
    sendJson(response, 404, { error: 'unknown creator route' });
  }

  private async handleCallback(url: URL, response: ServerResponse): Promise<void> {
    const error = url.searchParams.get('error');
    if (error) {
      sendHtml(response, 400, 'Sign-in was not completed', 'Pickford did not approve this connection. Close this tab and try again from the renderer page.');
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      sendHtml(response, 400, 'Sign-in link was incomplete', 'Close this tab and start the sign-in again from the renderer page.');
      return;
    }
    try {
      await this.auth.completeSignIn({ code, state });
      sendHtml(response, 200, 'You are signed in to Pickford', 'Close this tab and go back to the renderer page. Your StoryBundles appear there.');
    } catch (failure) {
      sendHtml(response, 400, 'Sign-in was not completed', failure instanceof Error ? failure.message : 'Start the sign-in again from the renderer page.');
    }
  }
}
