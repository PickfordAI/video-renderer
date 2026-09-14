import { describe, expect, it } from 'vitest';

import {
  bundleAction,
  bundleTitle,
  DEFAULT_RENDER_MODE,
  rememberedRenderMode,
  rememberRenderMode,
  RENDERER_CHOICES,
  RENDER_MODE_STORAGE_KEY,
  canStopPlayback,
  environmentLabel,
  falKeyLabel,
  homeStatusMessage,
  playbackLabel,
  playbackSupportHref,
  rendererLabel,
  runIdentityLines,
  shouldAutoRefresh,
  signedInLabel,
} from './creator-state.js';

const ready = { evdId: 'a', title: 'Night Shift', premiseLine: 'One impossible alibi.', episodeNumber: 1, state: 'ready', reason: null };
const preparing = { ...ready, state: 'preparing', reason: 'Preparing images…' };
const blocked = { ...ready, state: 'blocked', reason: 'Voice sample rejected' };
const signedIn = { auth: { signedIn: true, email: 'creator@example.com' }, falKey: { present: true }, playback: { state: 'idle' } };

describe('labels', () => {
  it('names the environment and the signed-in account', () => {
    expect(environmentLabel('dev')).toBe('Pickford (dev)');
    expect(environmentLabel('prod')).toBe('Pickford');
    expect(signedInLabel({ signedIn: true, email: 'creator@example.com' })).toBe('Signed in as creator@example.com');
    expect(signedInLabel({ signedIn: true, email: null })).toBe('Signed in to Pickford');
    expect(signedInLabel(null)).toBe('Not signed in');
  });

  it('says only whether a fal key is present', () => {
    expect(falKeyLabel({ present: true })).toBe('Key present');
    expect(falKeyLabel({ present: false })).toBe('Key missing');
  });

  it('reports the renderer connection, including a fence', () => {
    expect(rendererLabel({ present: false })).toBe('Not connected yet');
    expect(rendererLabel({ present: true, installationName: 'Local video renderer' })).toBe('Connected as Local video renderer');
    expect(rendererLabel({ present: true, fenced: true, installationName: 'Local' })).toBe('Reconnecting needed');
  });

  it('turns the first-clip ETA into a human wait', () => {
    expect(playbackLabel({ state: 'preparing', firstClipEtaSeconds: 120 })).toMatch(/about 2 minutes/);
    expect(playbackLabel({ state: 'preparing', firstClipEtaSeconds: 60 })).toMatch(/about 1 minute/);
    expect(playbackLabel({ state: 'preparing', firstClipEtaSeconds: 0 })).toMatch(/any moment now/);
    expect(playbackLabel({ state: 'playing', firstClipEtaSeconds: null })).toBe('Playing');
    expect(playbackLabel(undefined)).toBe('No StoryBundle playing');
  });

  it('keeps backend failure details out of the visible playback label', () => {
    expect(playbackLabel({ state: 'failed', error: 'Images are still generating for this StoryBundle.' }))
      .toBe('This StoryBundle stopped unexpectedly');
    expect(playbackLabel({ state: 'failed', error: null })).toBe('This StoryBundle stopped unexpectedly');
  });

  it('offers Stop while a story is active or needs failed-run cleanup', () => {
    for (const state of ['starting', 'preparing', 'playing', 'failed']) {
      expect(canStopPlayback({ state, canStop: true })).toBe(true);
    }
    for (const state of ['idle', 'ended', 'stopped']) {
      expect(canStopPlayback({ state, canStop: false })).toBe(false);
    }
    expect(canStopPlayback({ state: 'failed', canStop: false })).toBe(false);
  });

  it('puts detailed failure context only in an opt-in support email', () => {
    const href = playbackSupportHref({
      state: 'failed',
      error: 'Story Orchestration rejected renderer-initiated start with HTTP 500',
      storyRunId: 'story-run-1',
      storyId: 1397,
      runId: 'renderer-run-1',
    });
    const url = new URL(href);

    expect(url.protocol).toBe('mailto:');
    expect(url.pathname).toBe('help@pickford.ai');
    expect(url.searchParams.get('subject')).toBe('StoryBundle playback problem');
    expect(url.searchParams.get('body')).toContain('Story Orchestration rejected renderer-initiated start with HTTP 500');
    expect(url.searchParams.get('body')).toContain('Story run: story-run-1');
    expect(playbackSupportHref({ state: 'playing' })).toBeNull();
  });

  it('names the account by role when no email is available', () => {
    expect(signedInLabel({ signedIn: true, email: null, role: 'creator' })).toBe('Signed in to Pickford (creator)');
    expect(signedInLabel({ signedIn: true, email: 'creator@example.com', role: 'creator' })).toBe('Signed in as creator@example.com');
  });
});

describe('bundle cards', () => {
  it('offers Play for a ready bundle once a fal key is present', () => {
    expect(bundleAction(ready, signedIn)).toEqual({ disabled: false, label: 'Play', detail: 'One impossible alibi.' });
  });

  it('disables a preparing bundle with the images message', () => {
    expect(bundleAction(preparing, signedIn)).toMatchObject({ disabled: true, label: 'Preparing images…' });
  });

  it('disables a blocked bundle and shows its reason', () => {
    expect(bundleAction(blocked, signedIn)).toEqual({ disabled: true, label: 'Unavailable', detail: 'Voice sample rejected' });
  });

  it('asks for the fal key before offering Play', () => {
    expect(bundleAction(ready, { ...signedIn, falKey: { present: false } }))
      .toMatchObject({ disabled: true, detail: 'Add your fal key above to play this StoryBundle.' });
  });

  it('refuses a second Play while a StoryBundle is already playing', () => {
    expect(bundleAction(ready, { ...signedIn, playback: { state: 'playing' } }))
      .toMatchObject({ disabled: true, detail: 'Another StoryBundle is playing.' });
  });

  it('titles a bundle with its episode number when it has one', () => {
    expect(bundleTitle(ready)).toBe('Night Shift · Episode 1');
    expect(bundleTitle({ ...ready, episodeNumber: null })).toBe('Night Shift');
  });

  it('auto-refreshes only while something is still preparing', () => {
    expect(shouldAutoRefresh([ready, preparing])).toBe(true);
    expect(shouldAutoRefresh([ready, blocked])).toBe(false);
    expect(shouldAutoRefresh(undefined)).toBe(false);
  });
});

describe('headline and identities', () => {
  it('walks the creator through sign-in, the fal key, then Play', () => {
    expect(homeStatusMessage({ auth: { signedIn: false } })).toMatch(/Sign in with Pickford/);
    expect(homeStatusMessage({ auth: { signedIn: true }, falKey: { present: false } })).toMatch(/fal key/);
    expect(homeStatusMessage(signedIn)).toMatch(/Pick a StoryBundle/);
    expect(homeStatusMessage({ ...signedIn, playback: { state: 'playing' } })).toBe('Playing');
  });

  it('shows the opaque start identities once Pickford resolves them', () => {
    expect(runIdentityLines({ storyRunId: 'run-1', storyId: 42, audienceJoinUrl: 'https://pickford.ai/join/x' }))
      .toEqual(['Story run run-1', 'Story 42', 'Audience link https://pickford.ai/join/x']);
    expect(runIdentityLines({ storyRunId: null, storyId: null, audienceJoinUrl: null })).toEqual([]);
  });
});

// PIC-1975: the renderer choice is the creator's third owned input, and it exists for cost.
describe('renderer choice', () => {
  const fakeStorage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  };

  it('offers Single Frame first and defaults to it', () => {
    expect(RENDERER_CHOICES.map(choice => choice.value)).toEqual(['single-frame', 'fal-max-ref2v']);
    expect(DEFAULT_RENDER_MODE).toBe('single-frame');
    expect(RENDERER_CHOICES[0].label).toMatch(/one still per line/);
    expect(RENDERER_CHOICES[1].label).toMatch(/several dollars per scene/);
    expect(rememberedRenderMode(fakeStorage())).toBe('single-frame');
  });

  it('remembers the last choice and ignores a stored value it no longer offers', () => {
    const storage = fakeStorage();
    expect(rememberRenderMode(storage, 'fal-max-ref2v')).toBe('fal-max-ref2v');
    expect(storage.getItem(RENDER_MODE_STORAGE_KEY)).toBe('fal-max-ref2v');
    expect(rememberedRenderMode(storage)).toBe('fal-max-ref2v');

    storage.setItem(RENDER_MODE_STORAGE_KEY, 'fal-turbo-i2v');
    expect(rememberedRenderMode(storage)).toBe('single-frame');
    expect(rememberRenderMode(storage, 'nonsense')).toBe('single-frame');
  });

  // Private browsing and blocked site data make these throw; a remembered preference is a
  // convenience and must never block Play.
  it('falls back to the default when storage is unavailable or throws', () => {
    const hostile = {
      getItem: () => { throw new Error('site data blocked'); },
      setItem: () => { throw new Error('site data blocked'); },
    };
    expect(rememberedRenderMode(hostile)).toBe('single-frame');
    expect(rememberedRenderMode(null)).toBe('single-frame');
    expect(() => rememberRenderMode(hostile, 'fal-max-ref2v')).not.toThrow();
    expect(rememberRenderMode(hostile, 'fal-max-ref2v')).toBe('fal-max-ref2v');
  });
});
