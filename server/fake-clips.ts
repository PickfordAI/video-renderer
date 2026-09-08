import { randomUUID } from 'node:crypto';

import type { ExternalPlayoutManager, ExternalPlayoutSession } from './external-renderer.js';
import type { PlayoutClipBoundary, PlayoutClipInput, PlayoutStatus } from './playout.js';

export const FAKE_CLIPS_ENV = 'PICKFORD_FAKE_CLIPS';
export const FAKE_CLIPS_FAIL_ONCE_AFTER_ENV = 'PICKFORD_FAKE_CLIPS_FAIL_ONCE_AFTER';

export function fakeClipsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FAKE_CLIPS_ENV] === '1';
}

export function fakeClipFailureAfter(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[FAKE_CLIPS_FAIL_ONCE_AFTER_ENV]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`${FAKE_CLIPS_FAIL_ONCE_AFTER_ENV} must be an integer from 1 to 100`);
  }
  return value;
}

function fakeClip(value: unknown): PlayoutClipInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('fake clip body must be an object');
  const clip = value as Partial<PlayoutClipInput>;
  if (!Number.isInteger(clip.position) || (clip.position as number) < 0) throw new Error('fake clip position is required');
  if (typeof clip.storyBlockId !== 'string' || !clip.storyBlockId) throw new Error('fake clip storyBlockId is required');
  if (typeof clip.durationSeconds !== 'number' || clip.durationSeconds < 0) throw new Error('fake clip durationSeconds is required');
  return clip as PlayoutClipInput;
}

class FakeClipPlayoutSession implements ExternalPlayoutSession {
  readonly sessionId = randomUUID();
  readonly hlsUrl = `fake://pickford-clips/${this.sessionId}`;
  private readonly boundaries = new Map<number, PlayoutClipBoundary>();
  private playedThroughPosition = -1;
  private outputSeconds = 0;
  private stopped = false;

  enqueue(value: unknown): PlayoutClipInput {
    if (this.stopped) throw new Error('fake clip playout is stopped');
    const clip = fakeClip(value);
    if (!this.boundaries.has(clip.position)) {
      const startSeconds = this.outputSeconds + (clip.leadInSeconds ?? 0);
      const endSeconds = startSeconds + clip.durationSeconds;
      this.boundaries.set(clip.position, {
        ...clip,
        startSeconds,
        endSeconds,
        holdSecondsBefore: 0,
        leadInSecondsBefore: clip.leadInSeconds ?? 0,
      });
      this.outputSeconds = endSeconds;
      this.playedThroughPosition = Math.max(this.playedThroughPosition, clip.position);
    }
    return clip;
  }

  status(): PlayoutStatus {
    return {
      sessionId: this.sessionId,
      hlsUrl: this.hlsUrl,
      state: this.stopped ? 'stopped' : 'streaming',
      normalizedClips: this.boundaries.size,
      pendingClips: 0,
      currentPosition: null,
      playedThroughPosition: this.playedThroughPosition,
      outputSeconds: this.outputSeconds,
      audienceSeconds: this.outputSeconds,
      holdSeconds: 0,
      leadInSeconds: [...this.boundaries.values()].reduce((total, clip) => total + clip.leadInSecondsBefore, 0),
      error: null,
      mediaDir: null,
      finalMp4: null,
    };
  }

  clipBoundary(position: number): PlayoutClipBoundary | null {
    return this.boundaries.get(position) ?? null;
  }

  stop(): void {
    this.stopped = true;
  }
}

/** Local smoke-test playout: preserve renderer lifecycle events without downloading or encoding media. */
export class FakeClipPlayoutManager implements ExternalPlayoutManager {
  private readonly sessions = new Map<string, FakeClipPlayoutSession>();

  async start(): Promise<ExternalPlayoutSession> {
    const session = new FakeClipPlayoutSession();
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async stop(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    session.stop();
    return true;
  }
}
