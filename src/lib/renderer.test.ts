import { afterEach, describe, expect, it, vi } from 'vitest';

const createTestReferences = () => ['Marcus Kent', 'Autumn Tate', 'June Morrison'].map(characterName => ({
  characterName, imageUrl: `https://images.example/${characterName.split(' ')[0]}.jpg`, audioUrl: `https://audio.example/${characterName.split(' ')[0]}.mp3`,
}));
import { buildRenderPrompt, renderBeat } from './renderer';
import type { RendererSettings } from './types';

function testRendererSettings(overrides: Partial<RendererSettings>): RendererSettings {
  return { renderMode: 'auto', continuityStrategy: 'none', initialImageUrl: '', generationConcurrency: 2, maxBufferedSeconds: 30, styleDescription: '', narrativeEngineUrl: '', narrativeAuthoringUrl: '', realtimeGatewayUrl: '', chatBackendUrl: '', setupMode: 'create', roomName: '', roomShortlink: '', evdId: '', storyType: 'CREATOR', sessionToken: '', autoRender: false, useCharacterReferences: false, characterReferences: [], resolution: '480P', duration: 5, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildRenderPrompt', () => {
  it('requires natural timing and unhurried speech within the configured clip', () => {
    const prompt = buildRenderPrompt({
      storyBlockId: 'beat-1',
      sceneIndex: 0,
      blockIndex: 0,
      sequence: 1,
      prompt: 'A guest quietly reveals the letter.',
    }, 8);

    expect(prompt).toContain('full 8-second shot');
    expect(prompt).toContain('natural conversational tempo');
    expect(prompt).toContain('never be sped up');
  });

  it('sends a dialogue-specific planned duration instead of the global minimum', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      requestId: 'request-1',
      videoUrl: 'https://video.example/one.mp4',
      timings: { totalSeconds: 42 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const settings = {
      duration: 5,
      resolution: '768P',
    } as RendererSettings;

    const clip = await renderBeat({
      storyBlockId: 'beat-1',
      sceneIndex: 0,
      blockIndex: 0,
      sequence: 1,
      durationSeconds: 11,
      prompt: 'Lily calmly delivers a complete line of dialogue in the hotel lobby.',
    }, settings);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ duration: 11 });
    expect(clip.durationSeconds).toBe(11);
    expect(clip.prompt).toContain('full 11-second shot');
  });

  it('labels and sends matched character images for reference-to-video', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      requestId: 'request-ref',
      videoUrl: 'https://video.example/reference.mp4',
      timings: { totalSeconds: 7.2 },
      generationMode: 'reference',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const settings = {
      duration: 5,
      resolution: '768P',
      useCharacterReferences: true,
      characterReferences: createTestReferences(),
    } as RendererSettings;

    const clip = await renderBeat({
      storyBlockId: 'beat-kent',
      sceneIndex: 0,
      blockIndex: 0,
      sequence: 1,
      prompt: 'Kent quietly questions Autumn in the hotel lobby.',
      characterNames: ['Marcus Kent', 'Autumn Tate'],
      speakerName: 'Marcus Kent',
    }, settings);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body.characterReferences).toEqual([
      expect.objectContaining({ characterName: 'Marcus Kent', imageUrl: 'https://images.example/Marcus.jpg', audioUrl: 'https://audio.example/Marcus.mp3' }),
      expect.objectContaining({ characterName: 'Autumn Tate', imageUrl: 'https://images.example/Autumn.jpg' }),
    ]);
    expect((body.characterReferences as Array<Record<string, unknown>>)[1].audioUrl).toBeUndefined();
    expect(body.prompt).toContain('Image 1 is the canonical appearance of Marcus Kent');
    expect(body.prompt).toContain('Image 2 is the canonical appearance of Autumn Tate');
    expect(body.prompt).toContain('Audio 1 is the canonical voice sample for Marcus Kent');
    expect(body.prompt).toContain('never repeat or quote the reference sample');
    expect(clip.generationMode).toBe('reference');
    expect(clip.referenceCharacters).toEqual(['Marcus Kent', 'Autumn Tate']);
  });

  it('uses the exact DSS dialogue performance as the only audio reference', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      requestId: 'request-dialogue',
      videoUrl: 'https://video.example/dialogue.mp4',
      timings: { totalSeconds: 6.1 },
      generationMode: 'reference',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const settings = {
      duration: 5,
      resolution: '768P',
      useCharacterReferences: true,
      characterReferences: createTestReferences(),
    } as RendererSettings;

    await renderBeat({
      storyBlockId: 'beat-june',
      sceneIndex: 0,
      blockIndex: 0,
      sequence: 1,
      prompt: 'June answers Marcus carefully.',
      characterNames: ['June Morrison', 'Marcus Kent'],
      speakerName: 'June Morrison',
      dialogueAudioUrl: 'https://audio.example/june-line.mp3',
      dialogueAudioDurationSeconds: 1.724082,
    }, settings);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      prompt: string;
      characterReferences: Array<Record<string, unknown>>;
    };
    expect(body.characterReferences[0]).toMatchObject({
      characterName: 'June Morrison',
      audioUrl: 'https://audio.example/june-line.mp3',
      audioRole: 'dialogue_performance',
      audioDurationSeconds: 1.724082,
    });
    expect(body.characterReferences[1].audioUrl).toBeUndefined();
    expect(body.prompt).toContain("Audio 1 is June Morrison's exact scripted dialogue performance");
    expect(body.prompt).toContain("Only June Morrison speaks in this shot");
    expect(body.prompt).not.toContain('never repeat or quote the reference sample');
  });
});

describe('explicit fal modes', () => {
  const beat = { storyBlockId: 'first', sceneIndex: 0, blockIndex: 0, sequence: 1, prompt: 'Marcus speaks quietly to Autumn.', characterNames: ['Marcus Kent', 'Autumn Tate'], speakerName: 'Marcus Kent' };
  const settings = { duration: 5, resolution: '480P', renderMode: 'fal-turbo-i2v', initialImageUrl: 'https://images.example/scene.jpg', useCharacterReferences: true, characterReferences: createTestReferences() } as RendererSettings;
  const generated = (name: string) => new Response(JSON.stringify({ requestId: name, videoUrl: `https://video.example/${name}.mp4`, timings: { totalSeconds: 2 }, generationMode: 'image' }));

  it('uses an image without claiming absent character images or voice references', async () => {
    const fetchMock = vi.fn().mockResolvedValue(generated('first'));
    vi.stubGlobal('fetch', fetchMock);
    const clip = await renderBeat(beat, settings);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ renderMode: 'fal-turbo-i2v', initialImageUrl: settings.initialImageUrl, characterReferences: [] });
    expect(body.prompt).not.toMatch(/Image [12]|Audio [12]|canonical voice/);
    expect(body.prompt).toContain('supplied initial image');
    expect(clip.generationMode).toBe('image');
  });

  it('chains the next Turbo request from the extracted final frame and resets on Stop', async () => {
    const { StudioRenderSession } = await import('./renderer');
    const session = new StudioRenderSession();
    const fetchMock = vi.fn().mockResolvedValueOnce(generated('first')).mockResolvedValueOnce(new Response(JSON.stringify({ imageUrl: 'data:image/jpeg;base64,test' }))).mockResolvedValueOnce(generated('second')).mockResolvedValueOnce(generated('fresh'));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    await session.render(beat, settings, signal);
    await session.render({ ...beat, storyBlockId: 'second' }, settings, signal);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/video-frame');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ videoUrl: 'https://video.example/first.mp4', position: 'last' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).initialImageUrl).toBe('data:image/jpeg;base64,test');
    session.reset();
    await session.render({ ...beat, storyBlockId: 'fresh' }, settings, signal);
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).initialImageUrl).toBe(settings.initialImageUrl);
  });

  it('does not submit another paid job if Stop occurs during frame extraction', async () => {
    const { StudioRenderSession } = await import('./renderer');
    const session = new StudioRenderSession();
    let finishFrame!: (value: Response) => void;
    const fetchMock = vi.fn().mockResolvedValueOnce(generated('first')).mockImplementationOnce(() => new Promise<Response>(resolve => { finishFrame = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    await session.render(beat, settings, new AbortController().signal);
    const controller = new AbortController();
    const next = session.render({ ...beat, storyBlockId: 'second' }, settings, controller.signal);
    controller.abort(); session.reset();
    finishFrame(new Response(JSON.stringify({ imageUrl: 'data:image/jpeg;base64,test' })));
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails before a request when no image matches an explicit ref2vid shot', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(renderBeat({ ...beat, characterNames: ['Unknown'] }, { ...settings, renderMode: 'fal-max-ref2v', initialImageUrl: '' })).rejects.toThrow('No image reference matches');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('shared Turbo session ownership', () => {
  it('rejects an overlapping manual or automatic shot before submitting another generation', async () => {
    const { StudioRenderSession } = await import('./renderer');
    const session = new StudioRenderSession();
    let finish!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const settings: RendererSettings = { duration: 5, resolution: '480P', renderMode: 'fal-turbo-i2v', continuityStrategy: 'last-frame-chain', initialImageUrl: 'https://images.example/scene.jpg', useCharacterReferences: false, characterReferences: [], generationConcurrency: 2, maxBufferedSeconds: 30, styleDescription: '', narrativeEngineUrl: '', narrativeAuthoringUrl: '', realtimeGatewayUrl: '', chatBackendUrl: '', setupMode: 'create', roomName: '', roomShortlink: '', evdId: '', storyType: 'CREATOR', sessionToken: '', autoRender: false };
    const beat = { storyBlockId: 'one', sceneIndex: 0, blockIndex: 0, sequence: 1, prompt: 'Lily enters the quiet lobby.' };
    const first = session.render(beat, settings, new AbortController().signal);
    await expect(session.render({ ...beat, storyBlockId: 'two' }, settings, new AbortController().signal)).rejects.toThrow('already generating');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(new Response(JSON.stringify({ requestId: 'one', videoUrl: 'https://example.com/one.mp4', timings: { totalSeconds: 2 } })));
    await first;
  });
});

describe('studio continuity capability boundary', () => {
  it('rejects connected-only camera anchors before a manual provider request', async () => {
    const { StudioRenderSession } = await import('./renderer');
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const settings = testRendererSettings({ renderMode: 'fal-max-ref2v', continuityStrategy: 'camera-anchors', initialImageUrl: 'https://images.example/scene.jpg' });
    await expect(new StudioRenderSession().render({ storyBlockId: 'one', sceneIndex: 0, blockIndex: 0, sequence: 1, prompt: 'Lily crosses the lobby.' }, settings, new AbortController().signal)).rejects.toThrow('connected StoryKernel bridge');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('permits independent Max studio shots without extracting preceding frames', async () => {
    const { StudioRenderSession } = await import('./renderer');
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ requestId: 'one', videoUrl: 'https://example.com/one.mp4', timings: { totalSeconds: 2 }, generationMode: 'reference' }))));
    vi.stubGlobal('fetch', fetchMock);
    const settings = testRendererSettings({ renderMode: 'fal-max-ref2v', continuityStrategy: 'none', initialImageUrl: 'https://images.example/scene.jpg' });
    const session = new StudioRenderSession();
    const beat = { storyBlockId: 'one', sceneIndex: 0, blockIndex: 0, sequence: 1, prompt: 'Lily crosses the lobby.' };
    await Promise.all([session.render(beat, settings, new AbortController().signal), session.render({ ...beat, storyBlockId: 'two' }, settings, new AbortController().signal)]);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/generate', '/api/generate']);
  });
});
