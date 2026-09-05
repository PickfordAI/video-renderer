import { createHash } from 'node:crypto';

/** Stable UUIDv5 identity for one logical event, independent of delivery timestamp. */
export function rendererEventId(identity: readonly unknown[]): string {
  const bytes = createHash('sha1')
    .update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex'))
    .update(JSON.stringify(['pickford.video-renderer.event.v1', ...identity]))
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Json = Record<string, unknown>;
const SUCCESS_OUTCOMES = new Set(['accepted', 'accepted_pending_gap', 'idempotent_duplicate', 'ignored_lifecycle']);
const OUTCOMES = new Set([...SUCCESS_OUTCOMES, 'malformed', 'wrong_episode', 'stale_assignment', 'stale_generation', 'after_terminal', 'behind_confirmed_frontier', 'idempotency_conflict']);
const REJECTION_CODES = new Set(['malformed', 'correlation_conflict', 'idempotency_conflict', 'stale_session', 'backpressure', 'dependency_unavailable']);
function object(value: unknown): Json | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null; }

interface PendingEvent {
  event: Json;
  episodeId?: number;
  verdictId?: string;
  outcome?: string;
  acknowledged: boolean;
  transportRejected: boolean;
  sentAt: number;
}
export interface RendererEventVerdictStatus {
  pending: number;
  acknowledged: number;
  refused: number;
  ignored: number;
  lastOutcome: { clientEventId: string; verdictId: string; outcome: string; confirmedFrontier: number | null } | null;
  lastTransportRejection: { clientEventId: string | null; code: string; retryable: boolean } | null;
}
export interface VerdictAcknowledgement {
  message: { type: 'renderer.event.verdict.ack'; protocol_version: 1; verdict_id: string; client_event_id: string };
  failure: string | null;
}

/** Run-local delivery evidence. ACK means receipt of an outcome, never successful playback. */
export class RendererEventVerdicts {
  readonly status: RendererEventVerdictStatus = { pending: 0, acknowledged: 0, refused: 0, ignored: 0, lastOutcome: null, lastTransportRejection: null };
  private readonly events = new Map<string, PendingEvent>();

  assertHealthy(): void {
    for (const pending of this.events.values()) {
      if (!pending.acknowledged && !pending.verdictId && Date.now() - pending.sentAt >= 30_000) {
        throw new Error('StoryKernel renderer verdict timed out after 30 seconds');
      }
    }
  }

  register(event: Json, episodeId?: number): Json {
    this.assertHealthy();
    if (typeof event.client_event_id !== 'string' || !event.client_event_id) throw new Error('Renderer event requires client_event_id');
    const existing = this.events.get(event.client_event_id);
    if (existing) return existing.event; // Preserve the original timestamp/body for any repeated send.
    if (this.status.pending >= 128) throw new Error('StoryKernel renderer verdict backlog exceeded 128 pending events');
    this.events.set(event.client_event_id, { event, episodeId, acknowledged: false, transportRejected: false, sentAt: Date.now() });
    this.status.pending += 1;
    return event;
  }

  receiveVerdict(message: Json, currentAssignment: string | null): VerdictAcknowledgement | null {
    const verdict = object(message.verdict);
    const clientEventId = verdict?.client_event_id;
    const pending = typeof clientEventId === 'string' ? this.events.get(clientEventId) : undefined;
    const route = object(verdict?.route);
    const correlation = object(verdict?.correlation);
    const event = pending?.event;
    if (message.protocol_version !== 1 || !verdict || !pending || !event || !route || !correlation
      || route.renderer_id !== event.stream_id || route.stream_id !== event.stream_id
      || route.renderer_lease_id !== event.assignment_id || route.assignment_generation !== event.assignment_generation
      || correlation.sequence !== event.sequence
      || (pending.episodeId !== undefined && correlation.episode_id !== pending.episodeId)
      || (currentAssignment !== null && currentAssignment !== `${event.assignment_id}:${event.assignment_generation}`)) {
      this.status.ignored += 1;
      return null;
    }
    if (typeof verdict.verdict_id !== 'string' || !verdict.verdict_id || typeof verdict.outcome !== 'string' || !OUTCOMES.has(verdict.outcome)) {
      throw new Error('Malformed renderer verdict for a pending event');
    }
    if (pending.verdictId && (pending.verdictId !== verdict.verdict_id || pending.outcome !== verdict.outcome)) {
      throw new Error('Conflicting renderer verdict for a pending event');
    }
    if (!pending.verdictId) {
      pending.verdictId = verdict.verdict_id;
      pending.outcome = verdict.outcome;
      if (!SUCCESS_OUTCOMES.has(verdict.outcome)) this.status.refused += 1;
    }
    this.status.lastOutcome = {
      clientEventId: clientEventId as string, verdictId: verdict.verdict_id, outcome: verdict.outcome,
      confirmedFrontier: typeof verdict.confirmed_frontier === 'number' ? verdict.confirmed_frontier : null,
    };
    return {
      message: { type: 'renderer.event.verdict.ack', protocol_version: 1, verdict_id: verdict.verdict_id, client_event_id: clientEventId as string },
      failure: SUCCESS_OUTCOMES.has(verdict.outcome) ? null : `StoryKernel refused renderer event: ${verdict.outcome}`,
    };
  }

  acknowledge(ack: VerdictAcknowledgement['message']): void {
    const pending = this.events.get(ack.client_event_id);
    if (!pending || pending.verdictId !== ack.verdict_id) throw new Error('Cannot acknowledge an unmatched renderer verdict');
    if (pending.acknowledged) return;
    pending.acknowledged = true;
    this.status.pending -= 1;
    this.status.acknowledged += 1;
  }

  receiveRejection(message: Json): string | null {
    if (message.protocol_version !== 1 || (message.client_event_id !== null && typeof message.client_event_id !== 'string')
      || typeof message.code !== 'string' || !REJECTION_CODES.has(message.code) || typeof message.retryable !== 'boolean') {
      throw new Error('Malformed renderer transport rejection');
    }
    const clientEventId = message.client_event_id as string | null;
    const pending = clientEventId === null ? undefined : this.events.get(clientEventId);
    if (clientEventId !== null && (!pending || pending.acknowledged)) { this.status.ignored += 1; return null; }
    if (!pending?.transportRejected) this.status.refused += 1;
    if (pending) pending.transportRejected = true;
    this.status.lastTransportRejection = { clientEventId, code: message.code, retryable: message.retryable };
    // A transport rejection has no verdict_id and cannot be verdict-ACKed.
    return `StoryKernel rejected renderer event transport: ${message.code}${message.retryable ? ' (retryable; no automatic resend)' : ''}`;
  }
}
