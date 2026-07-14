import { describe, it, expect, vi } from 'vitest';
import { createConcurrencyGuard } from '../concurrency.js';

describe('ConcurrencyGuard', () => {
  it('allows up to maxReads concurrent READ acquires', async () => {
    const guard = createConcurrencyGuard(3);
    const releases: Array<() => void> = [];

    for (let i = 0; i < 3; i++) {
      const release = await guard.acquireRead();
      releases.push(release);
    }

    expect(guard.stats().activeReads).toBe(3);
    releases.forEach((r) => r());
    expect(guard.stats().activeReads).toBe(0);
  });

  it('queues the (maxReads+1)th READ until a slot frees', async () => {
    const guard = createConcurrencyGuard(2);
    const r1 = await guard.acquireRead();
    const r2 = await guard.acquireRead();

    // Third acquire should not resolve immediately
    let resolved = false;
    const p3 = guard.acquireRead().then((r) => {
      resolved = true;
      return r;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    expect(guard.stats().queuedCount).toBe(1);

    // Release one slot
    r1();
    const r3 = await p3;
    expect(resolved).toBe(true);
    expect(guard.stats().activeReads).toBe(2);

    r2();
    r3();
    expect(guard.stats().activeReads).toBe(0);
  });

  it('serializes WRITE calls to the same host', async () => {
    const guard = createConcurrencyGuard(5);
    const order: string[] = [];

    // Acquire write lock on host-A
    const r1 = await guard.acquireWrite('host-A');

    // Second write to same host should queue
    let secondAcquired = false;
    const p2 = guard.acquireWrite('host-A').then((r) => {
      secondAcquired = true;
      order.push('second');
      return r;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAcquired).toBe(false);

    // Release first
    order.push('first');
    r1();
    const r2 = await p2;
    expect(order).toEqual(['first', 'second']);

    r2();
  });

  it('allows concurrent WRITE to different hosts', async () => {
    const guard = createConcurrencyGuard(5);

    const r1 = await guard.acquireWrite('host-A');
    const r2 = await guard.acquireWrite('host-B');

    expect(guard.stats().activeWrites).toContain('host-A');
    expect(guard.stats().activeWrites).toContain('host-B');

    r1();
    r2();
    expect(guard.stats().activeWrites).toHaveLength(0);
  });

  it('does not block READ when a WRITE is held on the same host', async () => {
    // READs and WRITEs use independent mechanisms. A READ should proceed
    // even if a WRITE is held (the SSH layer serializes on its own channel).
    const guard = createConcurrencyGuard(5);

    const wRelease = await guard.acquireWrite('host-A');
    const rRelease = await guard.acquireRead();

    expect(guard.stats().activeWrites).toContain('host-A');
    expect(guard.stats().activeReads).toBe(1);

    wRelease();
    rRelease();
  });

  it('fails open after timeout on READ acquire', async () => {
    vi.useFakeTimers();
    const guard = createConcurrencyGuard(1);

    const r1 = await guard.acquireRead();

    const p2 = guard.acquireRead();
    const spy = vi.fn();
    p2.then(spy);

    // Advance past the 60s timeout
    await vi.advanceTimersByTimeAsync(61_000);

    expect(spy).toHaveBeenCalled();
    const release = await p2;
    // Fail-open release is a no-op
    release();
    expect(guard.stats().activeReads).toBe(1);

    r1();
    vi.useRealTimers();
  });

  it('reports correct stats', async () => {
    const guard = createConcurrencyGuard(3);

    const r1 = await guard.acquireRead();
    const r2 = await guard.acquireRead();
    const r3 = await guard.acquireRead();
    const w1 = await guard.acquireWrite('host-X');

    const stats = guard.stats();
    expect(stats.activeReads).toBe(3);
    expect(stats.activeWrites).toEqual(['host-X']);
    expect(stats.queuedCount).toBe(0);

    // Queue a 4th read (maxReads=3, all slots taken)
    const p4 = guard.acquireRead();
    expect(guard.stats().queuedCount).toBe(1);

    r1();
    const r4 = await p4;
    expect(guard.stats().queuedCount).toBe(0);

    r2();
    r3();
    r4();
    w1();
  });
});
