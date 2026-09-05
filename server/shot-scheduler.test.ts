import { describe, expect, it, vi } from 'vitest';
import { ShotScheduler } from './shot-scheduler.js';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
describe('shot scheduler', () => {
  it('runs independent setups concurrently and unlocks dependents before playback', async () => {
    const scheduler = new ShotScheduler<string>(2, 30, new AbortController().signal);
    const anchor = deferred<string>();
    const second = vi.fn(async () => 'same-camera');
    const independent = vi.fn(async () => 'other-camera');
    const a = scheduler.add(5, () => anchor.promise);
    const b = scheduler.add(5, second, a.result);
    const c = scheduler.add(5, independent);
    await tick();
    expect(independent).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    anchor.resolve('anchor');
    await expect(b.result).resolves.toBe('same-camera');
    await expect(c.result).resolves.toBe('other-camera');
    expect(second).toHaveBeenCalledOnce();
  });
  it('reserves duration in playback order so later work cannot starve an earlier dependent', async () => {
    const scheduler = new ShotScheduler<string>(3, 10, new AbortController().signal);
    const a = scheduler.add(5, async () => 'a');
    const bRun = vi.fn(async () => 'b');
    const cRun = vi.fn(async () => 'c');
    const b = scheduler.add(10, bRun, a.result);
    const c = scheduler.add(5, cRun);
    await a.result;
    await tick();
    expect(bRun).not.toHaveBeenCalled();
    expect(cRun).not.toHaveBeenCalled();
    a.release();
    await b.result;
    expect(cRun).not.toHaveBeenCalled();
    b.release();
    await expect(c.result).resolves.toBe('c');
  });
  it('fails anchor dependents without submitting them', async () => {
    const scheduler = new ShotScheduler<string>(2, 30, new AbortController().signal);
    const a = scheduler.add(5, async () => { throw new Error('anchor failed'); });
    const next = vi.fn(async () => 'never');
    const b = scheduler.add(5, next, a.result);
    await expect(a.result).rejects.toThrow('anchor failed');
    await expect(b.result).rejects.toThrow('anchor failed');
    expect(next).not.toHaveBeenCalled();
  });
  it('aborts queued work and drains running work without accepting a stale result', async () => {
    const controller = new AbortController();
    const scheduler = new ShotScheduler<string>(1, 5, controller.signal);
    const pending = deferred<string>();
    const a = scheduler.add(5, () => pending.promise);
    const next = vi.fn(async () => 'never');
    const b = scheduler.add(5, next);
    await tick();
    controller.abort(new Error('Stop'));
    pending.resolve('stale');
    await expect(a.result).rejects.toThrow('Stop');
    await expect(b.result).rejects.toThrow('Stop');
    await scheduler.drain();
    expect(next).not.toHaveBeenCalled();
  });
});
