import { describe, expect, it } from 'vitest';

import { desiredRunwaySeconds, ExternalPlaybackTracker, percentile90 } from './external-playback';

describe('ExternalPlaybackTracker', () => {
  it('advances only after every child shot in contiguous DSS sequences has played', () => {
    const tracker = new ExternalPlaybackTracker();
    tracker.register(1, ['1-a', '1-b']);
    tracker.register(2, ['2-a']);

    expect(tracker.markPlayed('2-a')).toBe(0);
    expect(tracker.markPlayed('1-a')).toBe(0);
    expect(tracker.markPlayed('1-b')).toBe(2);
  });

  it('lets a context-only sequence advance without manufacturing a video clip', () => {
    const tracker = new ExternalPlaybackTracker();

    expect(tracker.register(1, [])).toBe(1);
    expect(tracker.register(2, ['2-a'])).toBe(1);
    expect(tracker.markPlayed('2-a')).toBe(2);
  });

  it('holds an out-of-order sequence until the gap arrives', () => {
    const tracker = new ExternalPlaybackTracker();

    expect(tracker.register(2, [])).toBe(0);
    expect(tracker.register(1, [])).toBe(2);
  });
});

describe('adaptive runway', () => {
  it('uses a live p90 latency plus two clips of safety and caps excessive lead', () => {
    expect(percentile90([10_000, 20_000, 30_000, 40_000, 50_000])).toBe(50_000);
    expect(desiredRunwaySeconds(30_000, 5)).toBe(40);
    expect(desiredRunwaySeconds(300_000, 5)).toBe(120);
  });
});
