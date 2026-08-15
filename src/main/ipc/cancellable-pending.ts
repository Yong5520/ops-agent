// A pending promise that resolves on the first of: user response, abort, or
// timeout. Used by the agent IPC handlers for the blocking tool calls -
// authorization (`onAuthorizationRequired`), `ask_user` (`onAskUser`), and
// plan approval (`onPlanApproval`) - each of which blocks the agent loop
// waiting for user input.
//
// Three correctness properties (issues 1 & 2 root cause):
//
//   1b - Abort cancels immediately. When the user clicks Stop, `agent:cancel`
//        fires the session's AbortController. The pending promise must resolve
//        with a cancellation value so the tool returns and `runAgentLoop`
//        settles - otherwise `activeLoops` is never freed and the next run
//        throws "Agent loop already running for session …". The previous code
//        waited up to 5-10 minutes for the auto-timeout.
//
//   1d - A timed-out / aborted entry only deletes ITS OWN resolver from the
//        map. `ask_user` and plan-approval are keyed by sessionId, so a new
//        run can overwrite the key while an old timeout is still pending. The
//        old timeout must not delete or resolve the NEW entry (which would
//        orphan the new run's promise forever). We capture the resolver by
//        reference and only delete when `map.get(key) === resolver`.
//
//   idempotency - Whichever of {response, abort, timeout} wins, the rest
//        become no-ops (clearTimeout + removeEventListener guard).

export interface CancellablePendingOptions<T> {
  /** Map holding pending resolvers (keyed by toolCallId or sessionId). */
  map: Map<string, (value: T) => void>;
  /** Key under which this entry's resolver is registered. */
  key: string;
  /** The session's AbortSignal; abort resolves with `onAbort()`. */
  signal: AbortSignal | undefined;
  /** Idle timeout before resolving with `onTimeout()` (ms). */
  timeoutMs: number;
  /** Value resolved when the idle timeout elapses. */
  onTimeout: () => T;
  /** Value resolved when the abort signal fires. */
  onAbort: () => T;
}

export function createCancellablePending<T>(opts: CancellablePendingOptions<T>): Promise<T> {
  const { map, key, signal, timeoutMs, onTimeout, onAbort } = opts;
  return new Promise<T>((resolve) => {
    let settled = false;

    // The resolver registered in the map. Captured by reference so finish()
    // can verify it still owns the key before deleting - the 1d race fix: if a
    // newer entry overwrote `map.get(key)`, we leave the new entry alone and
    // only resolve our own (old) promise.
    const resolver: (value: T) => void = (value) => finish(value);

    // Scheduled first so finish() can always clear it. If the signal is already
    // aborted, finish() runs immediately below and clears this timeout (the
    // callback never fires).
    const timeoutId = setTimeout(() => finish(onTimeout()), timeoutMs);

    function finish(value: T): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbortEvent);
      if (map.get(key) === resolver) {
        map.delete(key);
      }
      resolve(value);
    }

    function onAbortEvent(): void {
      finish(onAbort());
    }

    // Already aborted before we attached (e.g. cancel arrived first, or the
    // session was deleted). Resolve immediately without registering.
    if (signal?.aborted) {
      finish(onAbort());
      return;
    }

    signal?.addEventListener('abort', onAbortEvent);
    map.set(key, resolver);
  });
}
