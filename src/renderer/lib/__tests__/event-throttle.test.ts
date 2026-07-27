import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBatchScheduler } from '../event-throttle.js';

// createBatchScheduler coalesces rapid text/thinking deltas and flushes them
// on a timer so the renderer doesn't re-render on every single token (which
// saturates the UI during a model flood - e.g. the qwen loop). Flushes
// immediately if a configurable max buffer size is reached (so very large
// bursts don't wait too long), and always flushes pending on dispose.

describe('createBatchScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple pushes into a single flush after the idle delay', () => {
    const flushed: string[] = [];
    const sched = createBatchScheduler<string>({
      idleDelayMs: 50,
      maxBufferSize: 1000,
      onFlush: (chunks) => {
        for (const c of chunks) flushed.push(c);
      },
    });
    sched.push('a');
    sched.push('b');
    sched.push('c');
    expect(flushed).toEqual([]); // not yet
    vi.advanceTimersByTime(49);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual(['a', 'b', 'c']);
    sched.dispose();
  });

  it('flushes immediately when maxBufferSize is reached', () => {
    const flushed: string[] = [];
    const sched = createBatchScheduler<string>({
      idleDelayMs: 1000,
      maxBufferSize: 5,
      onFlush: (chunks) => {
        for (const c of chunks) flushed.push(c);
      },
    });
    sched.push('1');
    sched.push('2');
    sched.push('3');
    sched.push('4');
    sched.push('5'); // reaches max -> immediate flush
    expect(flushed).toEqual(['1', '2', '3', '4', '5']);
    sched.dispose();
  });

  it('flushes pending on dispose', () => {
    const flushed: string[] = [];
    const sched = createBatchScheduler<string>({
      idleDelayMs: 1000,
      maxBufferSize: 1000,
      onFlush: (chunks) => {
        for (const c of chunks) flushed.push(c);
      },
    });
    sched.push('x');
    sched.dispose();
    expect(flushed).toEqual(['x']);
  });

  it('reset timer on each push (debounce-style)', () => {
    const flushed: string[] = [];
    const sched = createBatchScheduler<string>({
      idleDelayMs: 50,
      maxBufferSize: 1000,
      onFlush: (chunks) => {
        for (const c of chunks) flushed.push(c);
      },
    });
    sched.push('a');
    vi.advanceTimersByTime(30);
    sched.push('b'); // resets timer
    vi.advanceTimersByTime(30);
    sched.push('c'); // resets timer
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(50); // idle
    expect(flushed).toEqual(['a', 'b', 'c']);
    sched.dispose();
  });

  it('does not flush when empty', () => {
    const flushed: string[] = [];
    const sched = createBatchScheduler<string>({
      idleDelayMs: 10,
      maxBufferSize: 1000,
      onFlush: () => {
        flushed.push('called');
      },
    });
    vi.advanceTimersByTime(100);
    expect(flushed).toEqual([]);
    sched.dispose();
  });
});
