// Tests for createCancellablePending - the helper backing the agent IPC
// handlers' blocking tool calls (authorization / ask_user / plan approval).
//
// Three correctness properties (issues 1 & 2 root cause):
//   1b - abort resolves the promise immediately with a cancellation value
//        (so the tool returns, runAgentLoop settles, activeLoops is freed).
//   1d - a timed-out / aborted entry only deletes ITS OWN resolver from the
//        map; if a newer entry overwrote the key, the new entry is untouched.
//   idempotency - whichever of {response, abort, timeout} wins, the rest noop.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCancellablePending } from '../cancellable-pending.js';

describe('createCancellablePending', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the user response when the resolver is called', async () => {
    const map = new Map<string, (v: string) => void>();
    const promise = createCancellablePending<string>({
      map,
      key: 'k1',
      signal: undefined,
      timeoutMs: 60_000,
      onTimeout: () => 'timeout',
      onAbort: () => 'abort',
    });
    // Simulate the renderer responding.
    map.get('k1')!('user-answer');
    await expect(promise).resolves.toBe('user-answer');
    expect(map.has('k1')).toBe(false);
  });

  it('resolves with onAbort and cleans up when the signal aborts', async () => {
    const map = new Map<string, (v: string) => void>();
    const controller = new AbortController();
    const promise = createCancellablePending<string>({
      map,
      key: 'k1',
      signal: controller.signal,
      timeoutMs: 60_000,
      onTimeout: () => 'timeout',
      onAbort: () => 'abort',
    });
    controller.abort();
    await expect(promise).resolves.toBe('abort');
    expect(map.has('k1')).toBe(false);
  });

  it('resolves with onTimeout when the timeout elapses', async () => {
    const map = new Map<string, (v: string) => void>();
    const promise = createCancellablePending<string>({
      map,
      key: 'k1',
      signal: undefined,
      timeoutMs: 5_000,
      onTimeout: () => 'timeout',
      onAbort: () => 'abort',
    });
    vi.advanceTimersByTime(5_000);
    await expect(promise).resolves.toBe('timeout');
    expect(map.has('k1')).toBe(false);
  });

  it('resolves immediately with onAbort if the signal is already aborted', async () => {
    const map = new Map<string, (v: string) => void>();
    const controller = new AbortController();
    controller.abort();
    const promise = createCancellablePending<string>({
      map,
      key: 'k1',
      signal: controller.signal,
      timeoutMs: 60_000,
      onTimeout: () => 'timeout',
      onAbort: () => 'abort',
    });
    await expect(promise).resolves.toBe('abort');
    // Never registered in the map.
    expect(map.has('k1')).toBe(false);
  });

  it('only one of response/abort/timeout wins (idempotent cleanup)', async () => {
    const map = new Map<string, (v: string) => void>();
    const controller = new AbortController();
    const promise = createCancellablePending<string>({
      map,
      key: 'k1',
      signal: controller.signal,
      timeoutMs: 5_000,
      onTimeout: () => 'timeout',
      onAbort: () => 'abort',
    });
    // Fire all three; only the first (abort) should win.
    controller.abort();
    map.get('k1')?.('user-answer');
    vi.advanceTimersByTime(5_000);
    await expect(promise).resolves.toBe('abort');
    expect(map.has('k1')).toBe(false);
  });

  // ── 1d: the resolver race ───────────────────────────────────────────────
  it('a timed-out entry does NOT delete a newer entry that overwrote the key', async () => {
    const map = new Map<string, (v: string) => void>();
    // Old entry (simulates a previous run's orphaned ask_user promise).
    const oldPromise = createCancellablePending<string>({
      map,
      key: 'session-1',
      signal: undefined,
      timeoutMs: 5_000,
      onTimeout: () => 'old-timeout',
      onAbort: () => 'old-abort',
    });
    // A new run overwrites the key with its own resolver.
    const newResolver = vi.fn((v: string) => {
      // intentionally records the call
      void v;
    });
    map.set('session-1', newResolver);

    // Old entry's timeout fires. It must resolve the OLD promise (so the old
    // tool call returns) but must NOT delete or resolve the NEW entry.
    vi.advanceTimersByTime(5_000);
    await expect(oldPromise).resolves.toBe('old-timeout');
    // The new resolver is still the one in the map, untouched.
    expect(map.get('session-1')).toBe(newResolver);
    expect(newResolver).not.toHaveBeenCalled();
  });

  it('an aborted entry does NOT delete a newer entry that overwrote the key', async () => {
    const map = new Map<string, (v: string) => void>();
    const oldController = new AbortController();
    const oldPromise = createCancellablePending<string>({
      map,
      key: 'session-1',
      signal: oldController.signal,
      timeoutMs: 60_000,
      onTimeout: () => 'old-timeout',
      onAbort: () => 'old-abort',
    });
    const newResolver = vi.fn((v: string) => {
      void v;
    });
    map.set('session-1', newResolver);

    oldController.abort();
    await expect(oldPromise).resolves.toBe('old-abort');
    expect(map.get('session-1')).toBe(newResolver);
    expect(newResolver).not.toHaveBeenCalled();
  });
});
