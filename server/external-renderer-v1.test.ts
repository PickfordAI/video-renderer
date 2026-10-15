import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { ExternalRendererRunManager, parseExternalRendererRunConfig, type ExternalPlayoutManager } from './external-renderer.js';
import { rendererToken } from './v1-renderer-auth.js';

const rendererId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const assignmentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherRunId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const config = { startMode: 'v1', rendererId, clientId: 'hosted-video', clientSecret: 'fixture-secret', rendererVersion: 'h3.test.v1.0', environment: 'local' };

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('V1 renderer connection', () => {
  it('accepts machine or device-issued tokens without legacy credentials or story provisioning', () => {
    expect(parseExternalRendererRunConfig(config)).toMatchObject({ startMode: 'v1', credentialId: '', storyId: null });
    expect(parseExternalRendererRunConfig({ ...config, clientId: undefined, clientSecret: undefined, rendererAccessToken: 'fixture-token' })).toMatchObject({ rendererAccessToken: 'fixture-token', clientSecret: '' });
    expect(() => parseExternalRendererRunConfig({ ...config, clientId: undefined })).toThrow('V1 requires');
  });

  it('rejects grants for other renderers and non-V1 bridges', () => {
    const token = { access_token: 'fixture-token', scope: 'renderer.connect', expires_in: 900, renderer: { renderer_id: rendererId, session_generation: 1, bridge_url: 'wss://example.test/v1/renderers/bridge' } };
    expect(() => rendererToken(token, otherRunId)).toThrow('another renderer');
    expect(() => rendererToken({ ...token, renderer: { ...token.renderer, bridge_url: 'wss://example.test/api/v1/renderer-bridge/ws' } })).toThrow('Invalid V1');
  });

  it.each([
    { replacement: false, renderMode: 'auto' },
    { replacement: true, renderMode: 'auto' },
    { replacement: false, renderMode: 'single-frame' },
    { replacement: false, renderMode: 'fal-max-ref2v' },
  ])('correlates the assigned V1 run with $renderMode and fences replacement=$replacement', async ({ replacement, renderMode }) => {
    vi.stubEnv('FAL_KEY', 'fixture-no-provider-calls');
    const http = createServer();
    const ws = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const requests: string[] = [];
    const frames: Record<string, unknown>[] = [];
    const auth: string[] = [];
    ws.on('connection', (socket, request) => {
      auth.push(request.headers.authorization ?? '');
      expect(request.headers['sec-websocket-protocol']).toBe('pickford.renderer-bridge.v1');
      socket.on('message', raw => {
        const frame = JSON.parse(raw.toString());
        frames.push(frame);
        if (frame.type === 'renderer.hello') {
          socket.send(JSON.stringify({ type: 'renderer.welcome', stream_id: rendererId, session_id: sessionId, session_epoch: 1, lease_seconds: 30 }));
          socket.send(JSON.stringify({ type: 'renderer.assignment.state', session_id: sessionId, session_epoch: 1, assignment: null }));
          socket.send(JSON.stringify({ type: 'renderer.assignment.state', session_id: sessionId, session_epoch: 1, assignment: { assignment_id: assignmentId, assignment_generation: 1, story_run_id: runId } }));
        }
        if (frame.type === 'renderer.auth.refresh') socket.send(JSON.stringify({ type: 'renderer.auth.refreshed', session_id: sessionId, session_epoch: 1 }));
      });
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      requests.push(String(url));
      expect(String(url)).toBe(`${baseUrl}/v1/auth/token`);
      expect(JSON.parse(String(options.body))).toEqual({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret });
      return Response.json({ access_token: 'fixture-token', scope: 'renderer.connect', expires_in: 1, renderer: { renderer_id: rendererId, bridge_url: `ws://127.0.0.1:${port}/v1/renderers/bridge`, session_generation: 1 } });
    }));
    const playout = {
      start: async () => ({ sessionId: 'local-media', hlsUrl: 'fake://media', enqueue: vi.fn(), status: () => ({ state: 'streaming', playedThroughPosition: 99 }) }),
      stop: vi.fn(async () => true),
    } as unknown as ExternalPlayoutManager;
    const manager = new ExternalRendererRunManager(playout, { fakeClips: renderMode === 'auto' });
    const local = manager.start({ ...config, baseUrl, pickfordRunId: runId, rendererConfig: { model: renderMode } });
    try {
      await vi.waitFor(() => expect(manager.get(local.runId)).toMatchObject({ state: 'running', pickfordRunId: runId, storyRunId: runId }), { timeout: 2_000 });
      expect(local.runId).not.toBe(runId);
      expect(auth).toEqual(['Bearer fixture-token']);
      expect(frames[0]).toMatchObject({ type: 'renderer.hello', renderer_kind: 'generative_video', capabilities: ['assignment_state_v1'] });
      expect(frames[0]?.instance_id).toBe(local.runId);
      expect(frames[0]?.prepared_coverage_versions).toEqual(renderMode === 'fal-max-ref2v' ? [1] : undefined);
      expect(frames.some(frame => frame.type === 'renderer.asset_manifest')).toBe(false);
      expect(local.clips).toEqual([]);
      if (replacement) {
        for (const socket of ws.clients) socket.send(JSON.stringify({ type: 'renderer.assignment.state', session_id: sessionId, session_epoch: 1, assignment: { assignment_id: assignmentId, assignment_generation: 2, story_run_id: otherRunId } }));
        await vi.waitFor(() => expect(manager.get(local.runId)?.state).toBe('failed'));
        expect(local.failures.join(' ')).toContain('another Pickford run');
        expect(local.pickfordRunId).toBe(runId);
      } else {
        await vi.waitFor(() => expect(frames.some(frame => frame.type === 'renderer.auth.refresh')).toBe(true), { timeout: 2_000 });
        expect(requests.length).toBeGreaterThanOrEqual(2);
      }
      expect(requests.every(url => new URL(url).pathname.startsWith('/v1/'))).toBe(true);
    } finally {
      await manager.stop(local.runId);
      for (const socket of ws.clients) socket.terminate();
      await new Promise<void>(resolve => ws.close(() => http.close(() => resolve())));
    }
  });
});
