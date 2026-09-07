import { describe, expect, it } from 'vitest';

import { listStoryBundles, mapPublishedEvd, mapStoryBundle, storyBundleState } from './story-bundles.js';

const BFF = 'https://dev.pickford.ai';
const API = 'https://api.dev.pickford.ai';
const OWNER = 'c0ffee00-0000-4000-8000-000000000001';

function bundleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evd_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    cvd_id: 'bbbbbbbb-0000-4000-8000-000000000001',
    title: 'Night Shift',
    premise_line: 'Two detectives, one impossible alibi.',
    episode_number: 1,
    state: 'ready',
    publish_error: null,
    updated_at: '2026-09-07T10:00:00Z',
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('state mapping', () => {
  it('trusts the backend state when it sends one', () => {
    expect(storyBundleState({ state: 'preparing' })).toBe('preparing');
    expect(storyBundleState({ state: 'BLOCKED' })).toBe('blocked');
  });

  it('derives the state from is_published and publish_error otherwise', () => {
    expect(storyBundleState({ is_published: true })).toBe('ready');
    expect(storyBundleState({ is_published: false })).toBe('preparing');
    expect(storyBundleState({ is_published: true, publish_error: 'missing images' })).toBe('blocked');
  });

  it('gives a preparing bundle the images message and a blocked bundle its reason', () => {
    expect(mapStoryBundle(bundleRow({ state: 'preparing' }))).toMatchObject({ state: 'preparing', reason: 'Preparing images…' });
    expect(mapStoryBundle(bundleRow({ state: 'blocked', publish_error: 'Voice sample rejected' })))
      .toMatchObject({ state: 'blocked', reason: 'Voice sample rejected' });
    expect(mapStoryBundle(bundleRow())?.reason).toBeNull();
  });

  it('drops rows without a usable StoryBundle id', () => {
    expect(mapStoryBundle({ title: 'No id' })).toBeNull();
    expect(mapStoryBundle({ evd_id: 'not-a-uuid' })).toBeNull();
    expect(mapStoryBundle(null)).toBeNull();
  });
});

describe('published-evds fallback mapping', () => {
  it('maps the public episode shape and treats unpublished episodes as preparing', () => {
    const row = { id: 'aaaaaaaa-0000-4000-8000-000000000001', cvd_id: 'bbbbbbbb-0000-4000-8000-000000000001', cvd_name: 'Night Shift', name: 'Pilot', episode_number: 1, is_published: false };
    expect(mapPublishedEvd(row, OWNER).bundle).toMatchObject({ title: 'Pilot', state: 'preparing', episodeNumber: 1 });
  });

  it('filters by created_by_user_id when the payload carries one', () => {
    const mine = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Mine', is_published: true, created_by_user_id: OWNER };
    const theirs = { id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Theirs', is_published: true, created_by_user_id: 'dddddddd-0000-4000-8000-000000000009' };
    expect(mapPublishedEvd(mine, OWNER)).toMatchObject({ ownerKnown: true });
    expect(mapPublishedEvd(theirs, OWNER).bundle).toBeNull();
  });

  it('keeps the row, and says the owner is unknown, when the field is absent', () => {
    const row = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Mine', is_published: true };
    expect(mapPublishedEvd(row, OWNER)).toMatchObject({ ownerKnown: false });
    expect(mapPublishedEvd(row, OWNER).bundle?.state).toBe('ready');
  });
});

describe('listStoryBundles', () => {
  it('prefers the story-bundles endpoint and sorts ready bundles first', async () => {
    const impl = async (url: string): Promise<Response> => (url === `${BFF}/bff/v1/story-bundles`
      ? json([
        bundleRow({ evd_id: 'aaaaaaaa-0000-4000-8000-000000000002', title: 'Preparing one', state: 'preparing' }),
        bundleRow({ title: 'Ready one' }),
      ])
      : json({ detail: 'unexpected' }, 500));
    const listing = await listStoryBundles({ bffBaseUrl: BFF, apiBaseUrl: API, accessToken: 'a', userId: OWNER, fetchImpl: impl });
    expect(listing.adapter).toBe('story-bundles');
    expect(listing.bundles.map(bundle => bundle.title)).toEqual(['Ready one', 'Preparing one']);
  });

  it('falls back to published-evds when the endpoint is not deployed yet', async () => {
    const seen: string[] = [];
    const impl = async (url: string): Promise<Response> => {
      seen.push(url);
      if (url === `${BFF}/bff/v1/story-bundles`) return json({ detail: 'Not Found' }, 404);
      return json([{ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Pilot', cvd_name: 'Night Shift', episode_number: 1, is_published: true }]);
    };
    const listing = await listStoryBundles({ bffBaseUrl: BFF, apiBaseUrl: API, accessToken: 'a', userId: OWNER, fetchImpl: impl });
    expect(seen[1]).toBe(`${API}/show/published-evds?story_type=MINIMAX`);
    expect(listing.adapter).toBe('published-evds');
    expect(listing.ownerFilterApplied).toBe(false);
    expect(listing.bundles).toHaveLength(1);
  });

  it('does not fall back when the sign-in itself was rejected', async () => {
    const impl = async (): Promise<Response> => json({ detail: 'no' }, 401);
    await expect(listStoryBundles({ bffBaseUrl: BFF, apiBaseUrl: API, accessToken: 'a', userId: null, fetchImpl: impl }))
      .rejects.toThrow(/Sign in with Pickford again/);
  });
});
