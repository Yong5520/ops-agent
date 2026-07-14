// Concurrency guard for tool execution (P1-1).
//
// Design:
// - READ tools share a counting semaphore (max 5 concurrent).
// - WRITE/SUDO tools use a per-host mutex (one write per host at a time).
// - Guards live inside each tool's execute() function, so the AI SDK's
//   internal Promise.all scheduling is unaffected - we just gate entry.
// - Fail open: if a guard can't be acquired within 60s, log a warning and
//   proceed (don't block the agent loop indefinitely).

import { logger } from '../utils/logger.js';

export type ReleaseFunction = () => void;

export interface ConcurrencyGuard {
  acquireRead(): Promise<ReleaseFunction>;
  acquireWrite(hostId: string): Promise<ReleaseFunction>;
  stats(): { activeReads: number; activeWrites: string[]; queuedCount: number };
}

const ACQUIRE_TIMEOUT_MS = 60_000;

export function createConcurrencyGuard(maxReads = 5): ConcurrencyGuard {
  let activeReads = 0;
  const readQueue: Array<() => void> = [];
  const writeLocked = new Map<string, boolean>();
  const writeQueues = new Map<string, Array<() => void>>();

  function releaseRead(): void {
    activeReads--;
    const next = readQueue.shift();
    if (next) {
      activeReads++;
      next();
    }
  }

  function releaseWrite(hostId: string): void {
    writeLocked.set(hostId, false);
    const queue = writeQueues.get(hostId);
    const next = queue?.shift();
    if (next) {
      writeLocked.set(hostId, true);
      next();
    } else if (queue && queue.length === 0) {
      writeQueues.delete(hostId);
    }
  }

  return {
    acquireRead(): Promise<ReleaseFunction> {
      if (activeReads < maxReads) {
        activeReads++;
        return Promise.resolve(releaseRead);
      }

      return new Promise<ReleaseFunction>((resolve) => {
        const timer = setTimeout(() => {
          logger.warn(
            `[Concurrency] Read acquire timed out after ${ACQUIRE_TIMEOUT_MS}ms (fail open)`,
          );
          // Remove ourselves from the queue so we don't double-acquire later
          const idx = readQueue.indexOf(wake);
          if (idx >= 0) readQueue.splice(idx, 1);
          // Proceed without holding the semaphore (fail open)
          resolve(() => {});
        }, ACQUIRE_TIMEOUT_MS);

        const wake = () => {
          clearTimeout(timer);
          resolve(releaseRead);
        };
        readQueue.push(wake);
      });
    },

    acquireWrite(hostId: string): Promise<ReleaseFunction> {
      const locked = writeLocked.get(hostId) ?? false;
      if (!locked) {
        writeLocked.set(hostId, true);
        return Promise.resolve(() => releaseWrite(hostId));
      }

      return new Promise<ReleaseFunction>((resolve) => {
        const timer = setTimeout(() => {
          logger.warn(
            `[Concurrency] Write acquire for ${hostId} timed out after ${ACQUIRE_TIMEOUT_MS}ms (fail open)`,
          );
          const queue = writeQueues.get(hostId);
          const idx = queue ? queue.indexOf(wake) : -1;
          if (idx >= 0 && queue) queue.splice(idx, 1);
          resolve(() => {});
        }, ACQUIRE_TIMEOUT_MS);

        const wake = () => {
          clearTimeout(timer);
          writeLocked.set(hostId, true);
          resolve(() => releaseWrite(hostId));
        };

        let queue = writeQueues.get(hostId);
        if (!queue) {
          queue = [];
          writeQueues.set(hostId, queue);
        }
        queue.push(wake);
      });
    },

    stats() {
      let queuedCount = readQueue.length;
      for (const q of writeQueues.values()) queuedCount += q.length;
      return {
        activeReads,
        activeWrites: [...writeLocked.entries()].filter(([, v]) => v).map(([k]) => k),
        queuedCount,
      };
    },
  };
}
