import type { FetchLike } from './oauth-discovery.js';

/**
 * The creator's playable StoryBundles.
 *
 * "StoryBundle" is the user-facing name for what the API still calls an EVD (an episode of a CVD);
 * the wire field names are unchanged on purpose, so a rename on either side is a mapping change in
 * this file only.
 *
 * Primary adapter: `GET /bff/v1/story-bundles` (PIC-1739) returns
 * `{evd_id, cvd_id, title, premise_line, episode_number, state, publish_error, updated_at}`.
 * Fallback adapter: `GET /show/published-evds?story_type=MINIMAX` on the API origin, which exists
 * today but carries no premise line and (until PIC-1739) no owner field, so it is filtered by
 * `created_by_user_id` only when the payload happens to include it.
 */

export type StoryBundleState = 'ready' | 'preparing' | 'blocked';
export type StoryBundleAdapter = 'story-bundles' | 'published-evds';

export interface StoryBundle {
  evdId: string;
  cvdId: string | null;
  title: string;
  premiseLine: string | null;
  episodeNumber: number | null;
  state: StoryBundleState;
  /** Why a bundle is blocked, or what it is still waiting for. Never a raw stack trace. */
  reason: string | null;
  updatedAt: string | null;
}

export interface StoryBundleListing {
  bundles: StoryBundle[];
  adapter: StoryBundleAdapter;
  /** True when the fallback adapter could not scope the listing to the signed-in creator. */
  ownerFilterApplied: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_TIMEOUT_MS = 20_000;
export const PREPARING_REASON = 'Preparing images…';

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `state` is authoritative when the backend sends one; otherwise derive it from `is_published`. */
export function storyBundleState(raw: Record<string, unknown>): StoryBundleState {
  const declared = optionalText(raw.state)?.toLowerCase();
  if (declared === 'ready' || declared === 'preparing' || declared === 'blocked') return declared;
  if (optionalText(raw.publish_error)) return 'blocked';
  return raw.is_published === true ? 'ready' : 'preparing';
}

export function mapStoryBundle(value: unknown): StoryBundle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const evdId = optionalText(raw.evd_id) ?? optionalText(raw.id);
  if (!evdId || !UUID.test(evdId)) return null;
  const state = storyBundleState(raw);
  const publishError = optionalText(raw.publish_error);
  return {
    evdId,
    cvdId: optionalText(raw.cvd_id),
    title: optionalText(raw.title) ?? optionalText(raw.name) ?? 'Untitled StoryBundle',
    premiseLine: optionalText(raw.premise_line) ?? optionalText(raw.premise),
    episodeNumber: optionalNumber(raw.episode_number),
    state,
    reason: state === 'blocked' ? publishError ?? 'Pickford could not publish this StoryBundle.'
      : state === 'preparing' ? publishError ?? PREPARING_REASON
      : null,
    updatedAt: optionalText(raw.updated_at),
  };
}

/** The fallback shape: `PublishedEvdPublic` plus whatever extra fields the payload carries. */
export function mapPublishedEvd(value: unknown, ownerUserId: string | null): { bundle: StoryBundle | null; ownerKnown: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { bundle: null, ownerKnown: false };
  const raw = value as Record<string, unknown>;
  const owner = optionalText(raw.created_by_user_id);
  if (owner && ownerUserId && owner.toLowerCase() !== ownerUserId.toLowerCase()) return { bundle: null, ownerKnown: true };
  const bundle = mapStoryBundle({
    ...raw,
    title: optionalText(raw.name) ?? optionalText(raw.cvd_name),
    premise_line: optionalText(raw.premise_line) ?? optionalText(raw.cvd_name),
  });
  return { bundle, ownerKnown: Boolean(owner && ownerUserId) };
}

function sortBundles(bundles: StoryBundle[]): StoryBundle[] {
  const rank: Record<StoryBundleState, number> = { ready: 0, preparing: 1, blocked: 2 };
  return [...bundles].sort((left, right) =>
    rank[left.state] - rank[right.state]
    || (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
    || (left.episodeNumber ?? 0) - (right.episodeNumber ?? 0)
    || left.title.localeCompare(right.title));
}

async function get(url: string, accessToken: string, fetchImpl: FetchLike): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, status: response.status, body: null };
  }
  return { ok: true, status: response.status, body: await response.json() };
}

export async function listStoryBundles(options: {
  /** Frontend origin, which serves `/bff/v1/*`. */
  bffBaseUrl: string;
  /** API origin, which serves the `/show/*` fallback. */
  apiBaseUrl: string;
  accessToken: string;
  userId: string | null;
  storyType?: string;
  fetchImpl?: FetchLike;
}): Promise<StoryBundleListing> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const primary = await get(`${options.bffBaseUrl}/bff/v1/story-bundles`, options.accessToken, fetchImpl);
  if (primary.ok) {
    const rows = Array.isArray(primary.body) ? primary.body
      : Array.isArray((primary.body as { story_bundles?: unknown } | null)?.story_bundles) ? (primary.body as { story_bundles: unknown[] }).story_bundles
      : [];
    return {
      bundles: sortBundles(rows.map(mapStoryBundle).filter((bundle): bundle is StoryBundle => bundle !== null)),
      adapter: 'story-bundles',
      ownerFilterApplied: true,
    };
  }
  if (![404, 405].includes(primary.status)) {
    throw new Error(primary.status === 401
      ? 'Pickford did not accept this sign-in for the StoryBundle list. Sign in with Pickford again.'
      : `Pickford could not list your StoryBundles (HTTP ${primary.status}).`);
  }
  const storyType = options.storyType ?? 'MINIMAX';
  const fallback = await get(
    `${options.apiBaseUrl}/show/published-evds?story_type=${encodeURIComponent(storyType)}`,
    options.accessToken,
    fetchImpl,
  );
  if (!fallback.ok) {
    throw new Error(fallback.status === 401
      ? 'Pickford did not accept this sign-in for the StoryBundle list. Sign in with Pickford again.'
      : `Pickford could not list your StoryBundles (HTTP ${fallback.status}).`);
  }
  const rows = Array.isArray(fallback.body) ? fallback.body : [];
  const mapped = rows.map(row => mapPublishedEvd(row, options.userId));
  return {
    bundles: sortBundles(mapped.map(item => item.bundle).filter((bundle): bundle is StoryBundle => bundle !== null)),
    adapter: 'published-evds',
    ownerFilterApplied: mapped.length > 0 && mapped.every(item => item.ownerKnown),
  };
}
