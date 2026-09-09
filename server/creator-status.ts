import type { ExternalRendererRunStatus } from './external-renderer.js';
import { credentialFenced, credentialStatus, type CredentialStatus, type StoredCredential } from './renderer-credential.js';
import type { AuthStatus } from './oauth-store.js';
import type { FalKeyStatus } from './fal-key.js';
import type { StoryBundleAdapter } from './story-bundles.js';

/**
 * The single status payload the local page renders. Deliberate allowlist, exactly like
 * `viewer-status.ts`: no tokens, no client secret, no fal key, no service addresses.
 */

export type PlaybackState = 'idle' | 'starting' | 'preparing' | 'playing' | 'ended' | 'stopped' | 'failed';

export interface PlaybackStatus {
  state: PlaybackState;
  runId: string | null;
  evdId: string | null;
  storyRunId: string | null;
  storyId: number | null;
  audienceJoinUrl: string | null;
  hlsUrl: string | null;
  firstClipEtaSeconds: number | null;
  clipsRendered: number;
  /** Bounded backend diagnostic used only to prefill an explicit support email action. */
  error: string | null;
}

export interface CreatorStatus {
  environment: string;
  auth: AuthStatus;
  credential: CredentialStatus & { fenced: boolean };
  falKey: FalKeyStatus;
  bundleAdapter: StoryBundleAdapter | null;
  playback: PlaybackStatus;
  csrfToken: string | null;
}

/** Nominal wait before the first generated clip reaches playout, used until we have a measurement. */
export const NOMINAL_FIRST_CLIP_SECONDS = 120;

function playbackState(run: ExternalRendererRunStatus | null, played: boolean): PlaybackState {
  if (!run) return 'idle';
  if (run.state === 'failed') return 'failed';
  if (run.state === 'stopped') return 'stopped';
  if (run.state === 'ended') return 'ended';
  if (played && run.hlsUrl) return 'playing';
  return run.storyStartStatus === null ? 'starting' : 'preparing';
}

export function firstClipEtaSeconds(run: ExternalRendererRunStatus | null, nowMs: number): number | null {
  if (!run || !['connecting', 'running'].includes(run.state)) return null;
  if (run.clips?.some(clip => clip.playedAt !== null)) return null;
  const startedAt = Date.parse(run.storyStartAt ?? run.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  const measured = run.generationMsPercentiles?.median;
  const budgetSeconds = typeof measured === 'number' && Number.isFinite(measured) && measured > 0
    ? Math.round(measured / 1000) + 30
    : NOMINAL_FIRST_CLIP_SECONDS;
  return Math.max(0, budgetSeconds - Math.round((nowMs - startedAt) / 1000));
}

/**
 * The first failure is the cause; later ones are usually consequences of the same stop. A refusal
 * such as `STORY_BUNDLE_NOT_READY` already reads as a sentence, so it is passed through unchanged.
 */
export function playbackError(run: ExternalRendererRunStatus | null): string | null {
  if (!run || run.state !== 'failed') return null;
  const failure = run.failures.find(value => value.trim());
  return failure ? failure.trim().slice(0, 300) : 'This StoryBundle stopped unexpectedly.';
}

export function playbackStatus(run: ExternalRendererRunStatus | null, evdId: string | null, nowMs: number): PlaybackStatus {
  const played = run?.clips?.some(clip => clip.playedAt !== null) ?? false;
  const state = playbackState(run, played);
  return {
    state,
    runId: run?.runId ?? null,
    evdId,
    storyRunId: run?.storyRunId ?? null,
    storyId: run?.storyId ?? null,
    audienceJoinUrl: run?.audienceJoinUrl ?? null,
    // Same rule the watch page uses: never hand out a manifest before a real clip plays.
    hlsUrl: state === 'playing' ? run?.hlsUrl ?? null : null,
    firstClipEtaSeconds: firstClipEtaSeconds(run, nowMs),
    clipsRendered: run?.clipsRendered ?? 0,
    error: playbackError(run),
  };
}

export function creatorStatus(input: {
  environment: string;
  auth: AuthStatus;
  credential: StoredCredential | null;
  falKey: FalKeyStatus;
  bundleAdapter: StoryBundleAdapter | null;
  run: ExternalRendererRunStatus | null;
  evdId: string | null;
  nowMs: number;
  csrfToken: string | null;
}): CreatorStatus {
  return {
    environment: input.environment,
    auth: input.auth,
    credential: {
      ...credentialStatus(input.credential),
      fenced: Boolean(input.credential) && input.run?.state === 'failed' && credentialFenced(input.run.failures),
    },
    falKey: input.falKey,
    bundleAdapter: input.bundleAdapter,
    playback: playbackStatus(input.run, input.evdId, input.nowMs),
    csrfToken: input.csrfToken,
  };
}
