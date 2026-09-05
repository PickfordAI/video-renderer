/** One ordered planner may prepare ahead of one ordered playback consumer. */
export class PreparedFrameQueue<T> {
  private readonly values: T[] = [];
  private readonly changes = new EventTarget();
  private unfinished = 0;

  constructor(private readonly capacity: number, private readonly signal: AbortSignal) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid prepared frame capacity');
  }

  /** The factory runs only after space exists, so compilation and scheduling are bounded too. */
  async prepare(factory: () => T): Promise<void> {
    while (this.unfinished >= this.capacity) await this.waitForChange();
    this.signal.throwIfAborted();
    const value = factory();
    this.unfinished += 1;
    this.values.push(value);
    this.changes.dispatchEvent(new Event('change'));
  }

  async next(): Promise<{ value: T; release(): void }> {
    while (this.values.length === 0) await this.waitForChange();
    this.signal.throwIfAborted();
    const value = this.values.shift()!;
    let released = false;
    return { value, release: () => {
      if (released) return;
      released = true;
      this.unfinished -= 1;
      this.changes.dispatchEvent(new Event('change'));
    } };
  }

  async waitForIdle(signal: AbortSignal): Promise<void> {
    while (this.unfinished > 0) await this.waitForChange(signal);
    signal.throwIfAborted();
  }

  private waitForChange(signal = this.signal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        this.changes.removeEventListener('change', onChange);
      };
      const onAbort = () => { cleanup(); reject(signal.reason); };
      const onChange = () => { cleanup(); resolve(); };
      signal.addEventListener('abort', onAbort, { once: true });
      this.changes.addEventListener('change', onChange, { once: true });
    });
  }
}
