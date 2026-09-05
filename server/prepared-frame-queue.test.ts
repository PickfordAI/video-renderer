import { describe, expect, it, vi } from 'vitest';
import { PreparedFrameQueue } from './prepared-frame-queue.js';

describe('prepared payload budget', () => {
  it('counts the playing payload until release and prepares in FIFO order', async () => {
    const queue = new PreparedFrameQueue<number>(2, new AbortController().signal);
    await queue.prepare(() => 1);
    const first = await queue.next();
    await queue.prepare(() => 2);
    const third = vi.fn(() => 3);
    const pending = queue.prepare(third);
    await Promise.resolve();
    expect(third).not.toHaveBeenCalled();
    first.release(); first.release();
    await pending;
    expect((await queue.next()).value).toBe(2);
    expect((await queue.next()).value).toBe(3);
  });

  it('wakes both an empty consumer and a full producer on Stop without invoking blocked compilation', async () => {
    const controller = new AbortController();
    const full = new PreparedFrameQueue<number>(1, controller.signal);
    const empty = new PreparedFrameQueue<number>(1, controller.signal);
    await full.prepare(() => 1);
    const prepare = vi.fn(() => 2);
    const producer = full.prepare(prepare);
    const consumer = empty.next();
    controller.abort(new Error('Stop'));
    await expect(producer).rejects.toThrow('Stop');
    await expect(consumer).rejects.toThrow('Stop');
    expect(prepare).not.toHaveBeenCalled();
  });
});
