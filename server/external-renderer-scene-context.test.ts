import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import { ExternalRendererRunManager } from './external-renderer.js';
import { generateVideo } from './fal.js';
import { generateMiniMaxVideo } from './minimax.js';
import type { PlayoutManager } from './playout.js';

vi.mock('./fal.js', () => ({ generateVideo: vi.fn() }));
vi.mock('./minimax.js', () => ({ generateMiniMaxVideo: vi.fn() }));

type Json = Record<string, unknown>;

const rendererId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storyBlockId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const mayaId = '11111111-1111-4111-8111-111111111111';
const theoId = '22222222-2222-4222-8222-222222222222';
const inezId = '33333333-3333-4333-8333-333333333333';
const setAssetId = '44444444-4444-4444-8444-444444444444';
const mayaAssetId = '55555555-5555-4555-8555-555555555555';
const theoAssetId = '66666666-6666-4666-8666-666666666666';
const inezAssetId = '77777777-7777-4777-8777-777777777777';
const mayaName = 'Maya';
const theoName = 'Theo';
const inezName = 'Inéz 李';

const positions = {
  [mayaId]: 'Maya stands camera-left beside the rain-streaked window.',
  [theoId]: 'Theo sits camera-right across the narrow table.',
  [inezId]: 'Inez waits silently in the deep background near the doorway.',
};

function sceneContext(signature: string): Json {
  return {
    set_image: {
      asset_id: setAssetId,
      set_id: 'authored-set:hotel-lobby',
      image_url: `https://assets.example/hotel.png?signature=${signature}`,
    },
    character_images: [
      // Deliberately unrelated to talk-command order: names, not position, bind identities.
      { asset_id: inezAssetId, character_id: inezId, character_name: inezName, image_url: `https://assets.example/inez.png?signature=${signature}` },
      { asset_id: theoAssetId, character_id: theoId, character_name: theoName, image_url: `https://assets.example/theo.png?signature=${signature}` },
      { asset_id: mayaAssetId, character_id: mayaId, character_name: mayaName, image_url: `https://assets.example/maya.png?signature=${signature}` },
    ],
    character_positions: { ...positions },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function expectNamedImage(prompt: string, characterName: string, imageNumber: number): void {
  const escapedName = characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const imageLabel = `Image\\s+${imageNumber}\\b`;
  expect(prompt).toMatch(new RegExp(
    `(?:${escapedName}[\\s\\S]{0,240}${imageLabel}|${imageLabel}[\\s\\S]{0,240}${escapedName})`,
  ));
}

async function bridge(options: {
  provider?: 'fal-max-ref2v' | 'minimax-direct';
  shotPlanner?: Json;
} = {}) {
  const provider = options.provider ?? 'fal-max-ref2v';
  vi.stubEnv('MINIMAX_API_KEY', provider === 'minimax-direct' ? 'test-minimax-key' : '');
  vi.stubEnv('FAL_KEY', provider === 'fal-max-ref2v' ? 'test-fal-key' : '');
  vi.stubEnv('FAL_API_KEY', '');
  vi.mocked(generateVideo).mockReset().mockResolvedValue({ videoUrl: 'https://video.example/fal.mp4' } as Awaited<ReturnType<typeof generateVideo>>);
  vi.mocked(generateMiniMaxVideo).mockReset().mockResolvedValue({ videoUrl: 'https://video.example/minimax.mp4' } as Awaited<ReturnType<typeof generateMiniMaxVideo>>);

  const http = createServer();
  const websocket = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const sentEvents: Json[] = [];
  const send = (value: Json) => {
    for (const socket of websocket.clients) socket.send(JSON.stringify(value));
  };
  websocket.on('connection', (socket) => socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString()) as Json;
    sentEvents.push(event);
    if (event.type === 'renderer.hello') {
      socket.send(JSON.stringify({
        type: 'renderer.welcome',
        stream_id: rendererId,
        media_ingest_url: null,
        session_id: 'scene-context-session',
        session_epoch: 1,
        lease_seconds: 30,
      }));
    }
  }));

  const assetDownloads: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/login')) {
      return Response.json({ access_token: 'test-token', websocket_url: `ws://127.0.0.1:${port}` });
    }
    if (url.startsWith('https://assets.example/')) {
      assetDownloads.push(url);
      const filename = new URL(url).pathname.split('/').at(-1) ?? 'asset';
      return new Response(new TextEncoder().encode(`downloaded:${filename}`), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }
    return Response.json({ renderer_id: rendererId }, { status: 202 });
  });
  vi.stubGlobal('fetch', fetchMock);

  const enqueue = vi.fn();
  const stop = vi.fn(async () => undefined);
  const playout = {
    start: vi.fn(async () => ({
      sessionId: 'scene-context-media',
      hlsUrl: '/hls/scene-context.m3u8',
      enqueue,
      status: () => ({ state: 'streaming', playedThroughPosition: Number.MAX_SAFE_INTEGER }),
    })),
    stop,
  } as unknown as PlayoutManager;
  const manager = new ExternalRendererRunManager(playout);
  const run = manager.start({
    baseUrl: `http://127.0.0.1:${port}`,
    environment: 'local',
    rendererId,
    credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    clientSecret: 'test-client-secret',
    rendererVersion: 'h3.test.v1.0',
    storyId: 42,
    registerManifest: false,
    clipDurationSeconds: 5,
    ...(provider === 'fal-max-ref2v' ? {
      rendererConfig: { model: 'fal-max-ref2v', continuity: 'none', concurrency: 2, maxBufferedSeconds: 30 },
      shotPlanner: options.shotPlanner ?? {},
    } : {}),
  });
  await vi.waitFor(() => expect(run.state).toBe('running'));

  const frame = (sequence: number, options: { context?: Json; storyType?: number } = {}): Json => ({
    stream_id: rendererId,
    assignment_id: 'scene-context-assignment',
    assignment_generation: 1,
    sequence,
    story_block_id: storyBlockId,
    script: {
      sequence,
      story_type: options.storyType ?? 4,
      ...(options.context === undefined ? {} : { scene_context: options.context }),
      command_groups: [{
        id: `group-${sequence}`,
        commands: [{
          command: 'talk',
          args: { character: 'Maya', respondent: 'Theo', dialogue: 'The last train already left.' },
        }],
      }],
    },
  });

  return {
    run,
    frame,
    send,
    enqueue,
    assetDownloads,
    sentEvents,
    close: async () => {
      await manager.stopAll();
      for (const socket of websocket.clients) socket.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('certified MiniMax DSS scene context', () => {
  it.each([false, true])('rejects a visual payload with missing references before any provider submission (earlier valid group=%s)', async earlierValidGroup => {
    const fixture = await bridge({ shotPlanner: earlierValidGroup ? { characters: { Maya: { imageUrl: 'https://images.example/maya.png' } } } : {} });
    try {
      const payload = fixture.frame(1);
      if (earlierValidGroup) (payload.script as Json).command_groups = [
        { id: 'valid-group', commands: [{ command: 'talk', args: { character: 'Maya', dialogue: 'First line.', camera_shot: 'Character_CloseUp' } }] },
        { id: 'missing-reference-group', commands: [{ command: 'talk', args: { character: 'Theo', dialogue: 'Second line.', camera_shot: 'Character_CloseUp' } }] },
      ];
      fixture.send(payload);
      await vi.waitFor(() => expect(fixture.run.state).toBe('failed'));
      expect(fixture.run.failures.join(' ')).toContain('requires configured image references for every shot');
      expect(generateVideo).not.toHaveBeenCalled();
      expect(generateMiniMaxVideo).not.toHaveBeenCalled();
      expect(fixture.enqueue).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it('renders a chunk independently with its set, complete cast, and fixed positions', async () => {
    const fixture = await bridge();
    try {
      fixture.send(fixture.frame(1, { context: sceneContext('first') }));
      await vi.waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));

      const input = vi.mocked(generateVideo).mock.calls[0][0];
      expect(input.referenceImageUrls).toHaveLength(4);
      expect(input.referenceImageUrls).toEqual(expect.arrayContaining([
        'data:image/png;base64,ZG93bmxvYWRlZDpob3RlbC5wbmc=',
        'data:image/png;base64,ZG93bmxvYWRlZDptYXlhLnBuZw==',
        'data:image/png;base64,ZG93bmxvYWRlZDp0aGVvLnBuZw==',
        'data:image/png;base64,ZG93bmxvYWRlZDppbmV6LnBuZw==',
      ]));
      expect(input.prompt).toContain(positions[mayaId]);
      expect(input.prompt).toContain(positions[theoId]);
      expect(input.prompt).toContain(positions[inezId]);

      const setIndex = input.referenceImageUrls!.indexOf('data:image/png;base64,ZG93bmxvYWRlZDpob3RlbC5wbmc=') + 1;
      expect(setIndex).toBeGreaterThan(0);
      expect(input.prompt).toMatch(new RegExp(`(?:environment|setting|set)[^.]*(?:Image ${setIndex})|(?:Image ${setIndex})[^.]*(?:environment|setting|set)`, 'i'));
      for (const characterAsset of ['maya', 'theo', 'inez']) {
        const encoded = btoa(`downloaded:${characterAsset}.png`);
        const imageIndex = input.referenceImageUrls!.indexOf(`data:image/png;base64,${encoded}`) + 1;
        expect(imageIndex).toBeGreaterThan(0);
        expect(input.prompt).toContain(`Image ${imageIndex}`);
      }
    } finally {
      await fixture.close();
    }
  });

  it('binds exact talk names to the matching images and retains a silent participant', async () => {
    const fixture = await bridge();
    try {
      fixture.send(fixture.frame(1, { context: sceneContext('identity') }));
      await vi.waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));

      const input = vi.mocked(generateVideo).mock.calls[0][0];
      const references = input.referenceImageUrls ?? [];
      const mayaImage = references.indexOf(`data:image/png;base64,${btoa('downloaded:maya.png')}`) + 1;
      const theoImage = references.indexOf(`data:image/png;base64,${btoa('downloaded:theo.png')}`) + 1;
      const inezImage = references.indexOf(`data:image/png;base64,${btoa('downloaded:inez.png')}`) + 1;

      expect(mayaImage).toBeGreaterThan(0);
      expect(theoImage).toBeGreaterThan(0);
      expect(inezImage).toBeGreaterThan(0);
      expectNamedImage(input.prompt, mayaName, mayaImage);
      expectNamedImage(input.prompt, theoName, theoImage);
      expectNamedImage(input.prompt, inezName, inezImage);
      expect(input.prompt).toContain('The last train already left.');
    } finally {
      await fixture.close();
    }
  });

  it('reuses successful asset downloads by stable identity when signed URLs refresh', async () => {
    const fixture = await bridge();
    try {
      fixture.send(fixture.frame(1, { context: sceneContext('old') }));
      await vi.waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));
      fixture.send(fixture.frame(2, { context: sceneContext('refreshed') }));
      await vi.waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(2));

      expect(fixture.assetDownloads).toHaveLength(4);
      expect(fixture.assetDownloads.every((url) => url.endsWith('signature=old'))).toBe(true);
      expect(vi.mocked(generateVideo).mock.calls[1][0].referenceImageUrls)
        .toEqual(vi.mocked(generateVideo).mock.calls[0][0].referenceImageUrls);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ['empty context', {}],
    ['missing authored set identity', (() => { const value = sceneContext('bad'); delete (value.set_image as Json).set_id; return value; })()],
    ['non-HTTPS set image', (() => { const value = sceneContext('bad'); (value.set_image as Json).image_url = 'http://assets.example/hotel.png'; return value; })()],
    ['missing character image URL', (() => { const value = sceneContext('bad'); delete ((value.character_images as Json[])[1]).image_url; return value; })()],
    ['invalid asset identity', (() => { const value = sceneContext('bad'); ((value.character_images as Json[])[0]).asset_id = 'not-a-uuid'; return value; })()],
    ['missing character name', (() => { const value = sceneContext('bad'); delete ((value.character_images as Json[])[0]).character_name; return value; })()],
    ['blank character name', (() => { const value = sceneContext('bad'); ((value.character_images as Json[])[0]).character_name = '  '; return value; })()],
    ['duplicate character name', (() => { const value = sceneContext('bad'); ((value.character_images as Json[])[0]).character_name = theoName; return value; })()],
    ['case-mismatched command name', (() => { const value = sceneContext('bad'); ((value.character_images as Json[])[2]).character_name = 'maya'; return value; })()],
    ['missing silent-character position', (() => { const value = sceneContext('bad'); delete (value.character_positions as Json)[inezId]; return value; })()],
    ['extra unmatched position', (() => { const value = sceneContext('bad'); (value.character_positions as Json)['88888888-8888-4888-8888-888888888888'] = 'An unknown person is outside frame.'; return value; })()],
    ['blank position', (() => { const value = sceneContext('bad'); (value.character_positions as Json)[theoId] = '  '; return value; })()],
  ])('fails closed before video generation for %s', async (_label, malformed) => {
    const fixture = await bridge({
      shotPlanner: { characters: { Maya: { imageUrl: 'https://configured.example/maya.png' } } },
    });
    try {
      fixture.send(fixture.frame(1, { context: clone(malformed) }));
      await vi.waitFor(() => expect(fixture.run.state).toBe('failed'), { timeout: 750 });
      expect(generateVideo).not.toHaveBeenCalled();
      expect(fixture.enqueue).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });
});

describe('scene-context compatibility', () => {
  it('keeps legacy MiniMax chunks without scene context renderable', async () => {
    const fixture = await bridge({ provider: 'minimax-direct' });
    try {
      fixture.send(fixture.frame(1));
      await vi.waitFor(() => expect(generateMiniMaxVideo).toHaveBeenCalledTimes(1));
      expect(vi.mocked(generateMiniMaxVideo).mock.calls[0][0].referenceImageUrls).toBeUndefined();
      expect(generateVideo).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it('keeps non-Minimax rendering on its configured reference path', async () => {
    const fixture = await bridge({
      shotPlanner: { characters: { Maya: { imageUrl: 'https://configured.example/maya.png' } } },
    });
    try {
      fixture.send(fixture.frame(1, { storyType: 3 }));
      await vi.waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));
      expect(vi.mocked(generateVideo).mock.calls[0][0].referenceImageUrls).toEqual([
        'https://configured.example/maya.png',
      ]);
    } finally {
      await fixture.close();
    }
  });
});
