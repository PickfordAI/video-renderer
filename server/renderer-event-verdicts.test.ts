import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGroupFinishedEvent } from './external-renderer.js';
import { RendererEventVerdicts } from './renderer-event-verdicts.js';

const input = { streamId: 'renderer', assignmentId: 'lease', assignmentGeneration: 3, sequence: 7, storyBlockId: 'block', groupId: 'group', durationSeconds: 5 };
function event() { return createGroupFinishedEvent(input); }
function verdict(sent = event(), outcome = 'accepted') {
  return { type: 'renderer.event.verdict', protocol_version: 1, verdict: {
    verdict_id: 'verdict-1', client_event_id: sent.client_event_id,
    route: { renderer_id: 'renderer', stream_id: 'renderer', renderer_lease_id: 'lease', assignment_generation: 3 },
    correlation: { episode_id: 2, sequence: 7 }, outcome, confirmed_frontier: 7,
  } };
}
afterEach(() => vi.restoreAllMocks());

describe('renderer event identities and verdict receipts', () => {
  it('uses one stable ID per logical completion and keeps the exact original body on repeated sends', () => {
    const first = event();
    const repeated: Record<string, unknown> = { ...event(), timestamp: 9999 };
    expect(first.client_event_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(repeated.client_event_id).toBe(first.client_event_id);
    expect(createGroupFinishedEvent({ ...input, groupId: 'another-group' }).client_event_id).not.toBe(first.client_event_id);
    expect(createGroupFinishedEvent({ ...input, assignmentGeneration: 4 }).client_event_id).not.toBe(first.client_event_id);
    const ledger = new RendererEventVerdicts();
    expect(ledger.register(first, 2)).toBe(first);
    expect(ledger.register(repeated, 2)).toBe(first);
    expect(ledger.status.pending).toBe(1);
  });

  it('records outcomes before exact ACKs and handles duplicate delivery without double-counting', () => {
    const ledger = new RendererEventVerdicts();
    const sent = ledger.register(event(), 2);
    const ack = ledger.receiveVerdict(verdict(sent), 'lease:3')!;
    expect(ledger.status).toMatchObject({ pending: 1, acknowledged: 0, lastOutcome: { outcome: 'accepted' } });
    expect(ack.message).toEqual({ type: 'renderer.event.verdict.ack', protocol_version: 1, verdict_id: 'verdict-1', client_event_id: sent.client_event_id });
    ledger.acknowledge(ack.message);
    ledger.acknowledge(ledger.receiveVerdict(verdict(sent), 'lease:3')!.message);
    expect(ledger.status).toMatchObject({ pending: 0, acknowledged: 1, refused: 0 });
  });

  it.each(['renderer_id', 'stream_id', 'renderer_lease_id', 'assignment_generation', 'sequence', 'episode_id', 'client_event_id', 'active-assignment'])('does not ACK a verdict with mismatched %s', field => {
    const ledger = new RendererEventVerdicts();
    ledger.register(event(), 2);
    const message = verdict();
    if (field === 'sequence' || field === 'episode_id') Object.assign(message.verdict.correlation, { [field]: 99 });
    else if (field === 'client_event_id') message.verdict.client_event_id = 'unknown';
    else if (field !== 'active-assignment') Object.assign(message.verdict.route, { [field]: 'other' });
    expect(ledger.receiveVerdict(message, field === 'active-assignment' ? 'replacement:4' : 'lease:3')).toBeNull();
    expect(ledger.status).toMatchObject({ pending: 1, acknowledged: 0, ignored: 1 });
  });

  it('does not invent an episode when the DSS did not provide one', () => {
    const ledger = new RendererEventVerdicts();
    ledger.register(event());
    expect(ledger.receiveVerdict(verdict(), 'lease:3')?.message.verdict_id).toBe('verdict-1');
  });

  it('ACKs authoritative refusal after recording it and rejects conflicting duplicate outcomes', () => {
    const ledger = new RendererEventVerdicts();
    ledger.register(event(), 2);
    const ack = ledger.receiveVerdict(verdict(event(), 'behind_confirmed_frontier'), 'lease:3')!;
    expect(ledger.status).toMatchObject({ pending: 1, refused: 1, lastOutcome: { outcome: 'behind_confirmed_frontier' } });
    expect(ack.failure).toContain('behind_confirmed_frontier');
    ledger.acknowledge(ack.message);
    expect(ledger.status).toMatchObject({ pending: 0, acknowledged: 1, refused: 1 });
    expect(() => ledger.receiveVerdict(verdict(), 'lease:3')).toThrow('Conflicting');
  });

  it('records transport refusal separately, preserves unresolved evidence, and never fabricates a verdict ACK', () => {
    const ledger = new RendererEventVerdicts();
    ledger.register(event(), 2);
    expect(ledger.receiveRejection({ type: 'renderer.event.rejected', protocol_version: 1, client_event_id: event().client_event_id, code: 'backpressure', retryable: true })).toContain('no automatic resend');
    expect(ledger.status).toMatchObject({ pending: 1, acknowledged: 0, refused: 1, lastOutcome: null, lastTransportRejection: { code: 'backpressure', retryable: true } });
    expect(ledger.receiveRejection({ type: 'renderer.event.rejected', protocol_version: 1, client_event_id: 'unknown', code: 'malformed', retryable: false })).toBeNull();
  });

  it('bounds missing authoritative responses by elapsed time and count while a story is still running', () => {
    const ledger = new RendererEventVerdicts();
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    for (let sequence = 1; sequence <= 128; sequence++) ledger.register(createGroupFinishedEvent({ ...input, sequence }));
    expect(() => ledger.register(createGroupFinishedEvent({ ...input, sequence: 129 }))).toThrow('128 pending');
    vi.mocked(Date.now).mockReturnValue(now + 30_000);
    expect(() => ledger.assertHealthy()).toThrow('30 seconds');
    expect(ledger.status.pending).toBe(128);
  });
});
