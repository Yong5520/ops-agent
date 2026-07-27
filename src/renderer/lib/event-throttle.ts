// Render-side event throttle.
//
// During a model flood (e.g. the qwen3.5-27b 50-step repetition loop), the
// backend emits a TEXT_STREAM IPC event per token. Appending to the Zustand
// store and re-rendering the virtualized MessageList on every token saturates
// the renderer, which is why switching sessions mid-run appeared to "hang" -
// the click -> IPC -> state-update chain couldn't commit while the flood
// continued.
//
// createBatchScheduler coalesces rapid pushes and flushes on an idle timer
// (debounce-style) so we re-render at most ~20x/sec instead of per token. It
// flushes immediately when maxBufferSize is reached (large bursts don't wait)
// and always flushes pending data on dispose so nothing is dropped.

export interface BatchSchedulerOptions<T> {
  /** Debounce delay: flush this many ms after the last push. */
  idleDelayMs: number;
  /** Flush immediately once the pending buffer reaches this size. */
  maxBufferSize: number;
  /** Called with the coalesced batch. */
  onFlush: (batch: T[]) => void;
}

export interface BatchScheduler<T> {
  push(item: T): void;
  /** Flush any pending data immediately and stop the timer. */
  dispose(): void;
}

export function createBatchScheduler<T>(
  opts: BatchSchedulerOptions<T>,
): BatchScheduler<T> {
  let buffer: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    opts.onFlush(batch);
  };

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, opts.idleDelayMs);
  };

  return {
    push(item: T): void {
      buffer.push(item);
      // Immediate flush once the buffer is large enough (bounded latency).
      if (buffer.length >= opts.maxBufferSize) {
        flush();
        return;
      }
      schedule();
    },
    dispose(): void {
      flush();
    },
  };
}
