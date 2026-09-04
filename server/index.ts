import 'dotenv/config';

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';

import { ExternalRendererRunManager } from './external-renderer.js';
import { FalVideoError, generateVideo, type GenerateVideoInput } from './fal.js';
import { generateMiniMaxVideo, MiniMaxVideoError } from './minimax.js';
import { parseGenerationInput } from './generation-input.js';
import { handleNarrativeEngineApi } from './narrative-engine.js';
import { PlayoutManager } from './playout.js';
import { prepareReferenceAudioUrls } from './reference-audio.js';

const isDevelopment = process.argv.includes('--dev');
const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const distRoot = resolve(appRoot, 'dist');
const port = Number.parseInt(process.env.PORT ?? '4173', 10);
const maxRequestBytes = 32_000;
const playoutManager = new PlayoutManager();
const externalRendererRuns = new ExternalRendererRunManager(playoutManager);
const builtInReferenceAssets = new Set([
  'whispers/kent.jpg',
  'whispers/nathan.jpg',
  'whispers/richard.jpg',
  'whispers/cassandra.jpg',
  'whispers/june.jpg',
  'whispers/song.jpg',
  'whispers/autumn.jpg',
]);

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLocalUiRequest(request: IncomingMessage): boolean {
  const host = (request.headers.host ?? '').split(':', 1)[0];
  const source = request.headers.origin ?? request.headers.referer;
  const origin = source ? new URL(source) : null;
  return ['localhost', '127.0.0.1'].includes(host)
    && origin !== null
    && ['localhost', '127.0.0.1'].includes(origin.hostname)
    && request.headers['sec-fetch-site'] === 'same-origin';
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxRequestBytes) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function referenceAssetDataUrl(assetKey: string): string {
  if (!builtInReferenceAssets.has(assetKey)) throw new Error(`unknown character reference asset: ${assetKey}`);
  const assetRoot = isDevelopment ? join(appRoot, 'public', 'reference-assets') : join(distRoot, 'reference-assets');
  const assetPath = join(assetRoot, assetKey);
  if (!existsSync(assetPath)) throw new Error(`character reference asset is missing: ${assetKey}`);
  return `data:image/jpeg;base64,${readFileSync(assetPath).toString('base64')}`;
}

async function handleApi(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const requestUrl = new URL(request.url ?? '/', 'http://local');
  const pathname = requestUrl.pathname;
  if (pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, {
      ok: true,
      provider: process.env.MINIMAX_API_KEY ? 'minimax-direct' : 'fal',
      textModel: process.env.MINIMAX_API_KEY
        ? process.env.MINIMAX_VIDEO_MODEL_ID ?? 'MiniMax-H3-Max'
        : process.env.FAL_VIDEO_MODEL_ID ?? 'minimax/h3-max-turbo/text-to-video',
      referenceModel: process.env.MINIMAX_API_KEY
        ? process.env.MINIMAX_REFERENCE_VIDEO_MODEL_ID ?? 'MiniMax-H3'
        : process.env.FAL_REFERENCE_VIDEO_MODEL_ID ?? 'minimax/h3-max/reference-to-video',
      falKeyConfigured: Boolean(process.env.FAL_KEY || process.env.FAL_API_KEY),
      minimaxKeyConfigured: Boolean(process.env.MINIMAX_API_KEY),
      rendererPlatformConfigured: Boolean(
        process.env.RENDERER_PLATFORM_BASE_URL
        && process.env.RENDERER_ID
        && process.env.RENDERER_CREDENTIAL_ID
        && process.env.RENDERER_CLIENT_SECRET,
      ),
    });
    return true;
  }
  if (pathname === '/api/playout' && request.method === 'POST') {
    try {
      const startupBufferClips = requestUrl.searchParams.get('startup_buffer_clips') === '1' ? 1 : 2;
      const session = await playoutManager.start({ startupBufferClips });
      sendJson(response, 201, session.status());
    } catch (error) {
      sendJson(response, 503, { error: error instanceof Error ? error.message : 'could not start playout' });
    }
    return true;
  }
  if (pathname === '/api/external-renderer/runs' && request.method === 'POST') {
    if (!isLoopbackRequest(request)) {
      sendJson(response, 403, { error: 'external renderer runs may only be started from loopback' });
      return true;
    }
    try {
      sendJson(response, 202, externalRendererRuns.start(await readJson(request)));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'invalid external renderer run' });
    }
    return true;
  }
  if (pathname === '/api/external-renderer/connection') {
    if (!isLocalUiRequest(request)) {
      sendJson(response, 403, { error: 'renderer connection control requires the same-origin local UI' });
      return true;
    }
    try {
      if (request.method === 'POST') {
        await externalRendererRuns.stopActive();
        sendJson(response, 202, externalRendererRuns.startConfigured(await readJson(request)));
      } else if (request.method === 'GET') {
        const active = externalRendererRuns.active();
        sendJson(response, active ? 200 : 404, active ?? { error: 'renderer connection is not active' });
      } else if (request.method === 'DELETE') {
        const stopped = await externalRendererRuns.stopActive();
        sendJson(response, stopped ? 200 : 404, stopped ?? { error: 'renderer connection is not active' });
      } else {
        sendJson(response, 405, { error: 'method not allowed' });
      }
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'renderer connection failed' });
    }
    return true;
  }
  const connectionMatch = pathname.match(/^\/api\/external-renderer\/connection\/([0-9a-f-]{36})$/i);
  if (connectionMatch) {
    if (!isLocalUiRequest(request)) {
      sendJson(response, 403, { error: 'renderer connection control requires the same-origin local UI' });
      return true;
    }
    if (request.method !== 'DELETE') {
      sendJson(response, 405, { error: 'method not allowed' });
      return true;
    }
    const stopped = await externalRendererRuns.stopActive(connectionMatch[1]);
    sendJson(response, stopped ? 200 : 404, stopped ?? { error: 'renderer connection is not active' });
    return true;
  }
  const externalRunMatch = pathname.match(/^\/api\/external-renderer\/runs\/([0-9a-f-]{36})$/i);
  if (externalRunMatch) {
    if (request.method === 'GET') {
      const run = externalRendererRuns.get(externalRunMatch[1]);
      sendJson(response, run ? 200 : 404, run ?? { error: 'external renderer run not found' });
    } else if (request.method === 'DELETE') {
      const run = await externalRendererRuns.stop(externalRunMatch[1]);
      sendJson(response, run ? 200 : 404, run ?? { error: 'external renderer run not found' });
    } else {
      sendJson(response, 405, { error: 'method not allowed' });
    }
    return true;
  }
  const playoutMatch = pathname.match(/^\/api\/playout\/([0-9a-f-]{36})(\/clips)?$/i);
  if (playoutMatch) {
    const session = playoutManager.get(playoutMatch[1]);
    if (!session) {
      sendJson(response, 404, { error: 'playout session not found' });
      return true;
    }
    try {
      if (!playoutMatch[2] && request.method === 'GET') {
        sendJson(response, 200, session.status());
      } else if (playoutMatch[2] && request.method === 'POST') {
        const body = await readJson(request);
        if (body && typeof body === 'object' && !Array.isArray(body) && (body as { skip?: unknown }).skip === true) {
          session.skip((body as { position?: unknown }).position);
        } else {
          session.enqueue(body);
        }
        sendJson(response, 202, session.status());
      } else if (!playoutMatch[2] && request.method === 'DELETE') {
        await playoutManager.stop(session.sessionId);
        sendJson(response, 200, { stopped: true });
      } else {
        sendJson(response, 405, { error: 'method not allowed' });
      }
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'invalid playout request' });
    }
    return true;
  }
  if (pathname !== '/api/generate') return false;
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'method not allowed' });
    return true;
  }
  const minimaxApiKey = process.env.MINIMAX_API_KEY;
  const apiKey = minimaxApiKey || process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!apiKey) {
    sendJson(response, 503, { error: 'MINIMAX_API_KEY or FAL_KEY is not configured on the renderer server' });
    return true;
  }
  try {
    const parsedInput = parseGenerationInput(await readJson(request), referenceAssetDataUrl);
    const input: GenerateVideoInput = {
      ...parsedInput,
      referenceAudioUrls: await prepareReferenceAudioUrls(
        parsedInput.referenceAudioUrls,
        parsedInput.referenceAudioMetadata,
        { ffmpegPath: process.env.FFMPEG_PATH },
      ),
    };
    const controller = new AbortController();
    const abortGeneration = () => {
      if (!response.writableEnded) controller.abort(new DOMException('Renderer stopped', 'AbortError'));
    };
    request.once('aborted', abortGeneration);
    response.once('close', abortGeneration);
    const result = minimaxApiKey ? await generateMiniMaxVideo(input, {
      apiKey: minimaxApiKey,
      baseUrl: process.env.MINIMAX_API_BASE_URL,
      textModel: process.env.MINIMAX_VIDEO_MODEL_ID,
      referenceModel: process.env.MINIMAX_REFERENCE_VIDEO_MODEL_ID,
      signal: controller.signal,
    }) : await generateVideo(input, {
      apiKey,
      modelId: process.env.FAL_VIDEO_MODEL_ID,
      referenceModelId: process.env.FAL_REFERENCE_VIDEO_MODEL_ID,
      queueBaseUrl: process.env.FAL_QUEUE_BASE_URL,
      signal: controller.signal,
    });
    request.off('aborted', abortGeneration);
    response.off('close', abortGeneration);
    if (!controller.signal.aborted) sendJson(response, 200, result);
  } catch (error) {
    if (response.destroyed) return true;
    const message = error instanceof Error ? error.message : 'video generation failed';
    sendJson(response, error instanceof FalVideoError || error instanceof MiniMaxVideoError ? 502 : 400, { error: message });
  }
  return true;
}

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveProduction(request: IncomingMessage, response: ServerResponse): void {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://local').pathname);
  const requested = resolve(distRoot, `.${pathname}`);
  const isSafe = requested === distRoot || requested.startsWith(`${distRoot}/`);
  const filePath = isSafe && existsSync(requested) && statSync(requested).isFile()
    ? requested
    : join(distRoot, 'index.html');
  response.writeHead(200, {
    'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
  });
  createReadStream(filePath).pipe(response);
}

let vite: ViteDevServer | null = null;

const server = createServer(async (request, response) => {
  if (await handleNarrativeEngineApi(request, response)) return;
  if (await handleApi(request, response)) return;
  if (vite) {
    vite.middlewares(request, response, () => {
      response.statusCode = 404;
      response.end('Not found');
    });
    return;
  }
  serveProduction(request, response);
});

if (isDevelopment) {
  vite = await (await import('vite')).createServer({
    root: appRoot,
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
}

server.listen(port, '0.0.0.0', () => {
  console.log(`MiniMax Renderer listening at http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void externalRendererRuns.stopAll().then(() => playoutManager.stopAll()).finally(() => server.close());
  });
}
