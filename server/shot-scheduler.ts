/** Bounds paid work by both concurrent submissions and unplayed video duration. */
export interface ScheduledShot<T> {
  result: Promise<T>;
  release(): void;
}
interface Job<T> {
  seconds: number;
  ready: boolean;
  started: boolean;
  released: boolean;
  reserved: boolean;
  settled: boolean;
  run(): Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
export class ShotScheduler<T> {
  private readonly jobs: Job<T>[] = [];
  private readonly active = new Set<Promise<void>>();
  private reservedSeconds = 0;
  private running = 0;
  constructor(private readonly concurrency: number, private readonly maxBufferedSeconds: number, private readonly signal: AbortSignal) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || maxBufferedSeconds <= 0) throw new Error('Invalid shot scheduler limits');
    signal.addEventListener('abort', () => {
      for (const job of this.jobs) if (!job.started && !job.settled) {
        job.settled = true;
        job.reject(signal.reason ?? new Error('Shot scheduler stopped'));
      }
    }, { once: true });
  }
  add(seconds: number, run: () => Promise<T>, dependency?: Promise<unknown>): ScheduledShot<T> {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Shot duration must be positive');
    let job!: Job<T>;
    const result = new Promise<T>((resolve, reject) => {
      job = { seconds, ready: !dependency, started: false, released: false, reserved: false, settled: false, run, resolve, reject };
    });
    // Queued dependency failures may precede the ordered consumer reaching this job.
    void result.catch(() => undefined);
    this.jobs.push(job);
    if (this.signal.aborted) { job.settled = true; job.reject(this.signal.reason); }
    else if (dependency) void dependency.then(() => {
      if (!job.settled) { job.ready = true; this.pump(); }
    }, error => { if (!job.settled) { job.settled = true; job.reject(error); } });
    this.pump();
    return { result, release: () => {
      if (job.reserved && !job.released) { job.released = true; this.reservedSeconds -= job.seconds; this.pump(); }
    } };
  }
  private pump(): void {
    if (this.signal.aborted) return;
    for (const job of this.jobs) {
      if (this.running >= this.concurrency) return;
      if (job.started || job.settled) continue;
      // Reserve in playback order, including dependency waits: later independent work
      // must not consume the budget needed by an earlier unplayed dependent shot.
      if (!job.reserved) {
        if (this.reservedSeconds > 0 && this.reservedSeconds + job.seconds > this.maxBufferedSeconds) return;
        job.reserved = true;
        this.reservedSeconds += job.seconds;
      }
      if (!job.ready) continue;
      job.started = true;
      this.running += 1;
      const task = Promise.resolve().then(() => {
        this.signal.throwIfAborted();
        return job.run();
      }).then(value => { this.signal.throwIfAborted(); job.settled = true; job.resolve(value); }, error => {
        job.settled = true; job.reject(error);
      }).catch(error => { job.settled = true; job.reject(error); }).finally(() => {
        this.running -= 1;
        this.active.delete(task);
        this.pump();
      });
      this.active.add(task);
    }
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.active]); }
}
