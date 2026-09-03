import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultCharacterReferences } from './character-references';
import { buildRenderPrompt, renderBeat } from './renderer';
import type { RendererSettings } from './types';

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
      characterReferences: createDefaultCharacterReferences(),
    } as RendererSettings;

    const clip = await renderBeat({
      storyBlockId: 'beat-kent',
      sceneIndex: 0,
      blockIndex: 0,
      sequence: 1,
      prompt: 'Kent quietly questions Autumn in the hotel lobby.',
      characterNames: ['Kent', 'Autumn'],
      speakerName: 'Kent',
    }, settings);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body.characterReferences).toEqual([
      expect.objectContaining({ characterName: 'Marcus Kent', assetKey: 'whispers/kent.jpg', audioUrl: expect.stringContaining('/kent-') }),
      expect.objectContaining({ characterName: 'Autumn Tate', assetKey: 'whispers/autumn.jpg' }),
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
      characterReferences: createDefaultCharacterReferences(),
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
