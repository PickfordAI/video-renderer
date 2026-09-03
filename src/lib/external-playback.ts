interface SequenceState {
  beatIds: Set<string>;
  playedBeatIds: Set<string>;
}

export class ExternalPlaybackTracker {
  private readonly sequences = new Map<number, SequenceState>();
  private readonly sequenceByBeatId = new Map<string, number>();
  private playedThroughSequence = 0;

  reset(): void {
    this.sequences.clear();
    this.sequenceByBeatId.clear();
    this.playedThroughSequence = 0;
  }

  register(sequence: number, beatIds: string[]): number {
    if (sequence <= this.playedThroughSequence) return this.playedThroughSequence;
    const state = this.sequences.get(sequence) ?? {
      beatIds: new Set<string>(),
      playedBeatIds: new Set<string>(),
    };
    for (const beatId of beatIds) {
      state.beatIds.add(beatId);
      this.sequenceByBeatId.set(beatId, sequence);
    }
    this.sequences.set(sequence, state);
    return this.advanceContiguousFrontier();
  }

  markPlayed(beatId: string): number {
    const sequence = this.sequenceByBeatId.get(beatId);
    if (sequence === undefined) return this.playedThroughSequence;
    this.sequences.get(sequence)?.playedBeatIds.add(beatId);
    return this.advanceContiguousFrontier();
  }

  frontier(): number {
    return this.playedThroughSequence;
  }

  private advanceContiguousFrontier(): number {
    while (true) {
      const nextSequence = this.playedThroughSequence + 1;
      const state = this.sequences.get(nextSequence);
      if (!state) break;
      const complete = [...state.beatIds].every((beatId) => state.playedBeatIds.has(beatId));
      if (!complete) break;
      this.playedThroughSequence = nextSequence;
      this.sequences.delete(nextSequence);
      for (const beatId of state.beatIds) this.sequenceByBeatId.delete(beatId);
    }
    return this.playedThroughSequence;
  }
}

export function percentile90(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.9) - 1];
}

export function desiredRunwaySeconds(generationLatencyP90Ms: number | null, clipDuration: number): number {
  const latencySeconds = generationLatencyP90Ms === null ? clipDuration : generationLatencyP90Ms / 1_000;
  return Math.max(clipDuration * 2, Math.min(120, Math.ceil(latencySeconds + clipDuration * 2)));
}
