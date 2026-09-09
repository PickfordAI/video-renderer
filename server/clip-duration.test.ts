import { describe, expect, it } from 'vitest';
import { measuredClipDurationSeconds } from './clip-duration.js';

describe('returned clip duration', () => {
  it('preserves the longer selected track and rounds up to a complete frame', () => {
    expect(measuredClipDurationSeconds({ streams: [
      { codec_type: 'video', duration: '6.583333' },
      { codec_type: 'audio', duration: '6.592' },
    ] })).toBe(6.625);
  });

  it.each([undefined, 'N/A', '0'])('uses container duration when a track duration is %s', duration => {
    expect(measuredClipDurationSeconds({ streams: [
      { codec_type: 'video', duration: '6' }, { codec_type: 'audio', duration },
    ], format: { duration: '6.592' } })).toBe(6.625);
  });

  it('supports container-only duration without requiring audio', () => {
    expect(measuredClipDurationSeconds({ streams: [{ codec_type: 'video' }],
      format: { duration: '4.5' } })).toBe(4.5);
  });

  it('rejects missing timing rather than guessing a cutoff from the request', () => {
    expect(() => measuredClipDurationSeconds({ streams: [{ codec_type: 'video' }],
      format: { duration: 'N/A' } })).toThrow('no measurable');
    expect(() => measuredClipDurationSeconds({ streams: [], format: { duration: '6' } }))
      .toThrow('no video');
  });
});
