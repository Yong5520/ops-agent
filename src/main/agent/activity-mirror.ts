// Activity mirror (v24, plan option c - hybrid mirror).
//
// Records what the AI's exec channel actually sends and receives - the raw,
// UNCLEANED chunks (ANSI, pager prompts, echo) plus command boundaries - so
// the activity terminal can show exactly what the AI saw, like a BMC console
// mirror. The model still receives its cleaned output; this is a separate,
// passive tap.
//
// The ring buffer lives in the MAIN process so a mirror window opened
// mid-run can replay history (renderer-local stores died with the window).
// Events fan out to every interested window via activity-mirror-broadcast.

import { ALL_HOSTS, MULTI_HOST_BUCKET } from './mirror-buckets.js';
import type { AgentMirrorEvent } from '../../shared/activity-mirror-types.js';
import { logger } from '../utils/logger.js';

export { ALL_HOSTS, MULTI_HOST_BUCKET };
export type { AgentMirrorEvent };

export type MirrorInput =
  | Omit<Extract<AgentMirrorEvent, { kind: 'command' }>, 'seq'>
  | Omit<Extract<AgentMirrorEvent, { kind: 'chunk' }>, 'seq'>
  | Omit<Extract<AgentMirrorEvent, { kind: 'final' }>, 'seq'>;

// Bounded memory: max events kept (oldest dropped). Chunk-heavy sessions trim
// by byte budget as well so a few huge events can't pin unbounded memory.
const MAX_EVENTS = 200;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

const ring: AgentMirrorEvent[] = [];
let ringBytes = 0;
let nextSeq = 1;
const listeners = new Set<(event: AgentMirrorEvent) => void>();

function eventBytes(ev: AgentMirrorEvent): number {
  return ev.kind === 'chunk' ? Buffer.byteLength(ev.data) : 256;
}

/** Record one mirror event (assigns seq, trims the ring, notifies listeners). */
export function activityMirrorRecord(event: MirrorInput): void {
  const full = { ...event, seq: nextSeq++ } as AgentMirrorEvent;
  ring.push(full);
  ringBytes += eventBytes(full);
  while (ring.length > MAX_EVENTS || (ringBytes > MAX_TOTAL_BYTES && ring.length > 1)) {
    const dropped = ring.shift();
    if (!dropped) break;
    ringBytes -= eventBytes(dropped);
  }
  for (const listener of listeners) {
    try {
      listener(full);
    } catch (err) {
      // A broken subscriber must never break the exec path.
      try {
        logger.warn(`[ActivityMirror] Listener error: ${(err as Error).message}`);
      } catch {
        // ignore - logging must not throw either
      }
    }
  }
}

/**
 * History for replay, newest last. Scope by sessionId and host bucket
 * (hostId = ALL_HOSTS matches everything, including MULTI_HOST_BUCKET).
 * Returns a copy - callers cannot mutate the ring.
 */
export function activityMirrorHistory(
  sessionId?: string,
  hostId: string = ALL_HOSTS,
): AgentMirrorEvent[] {
  return ring.filter(
    (ev) =>
      (sessionId === undefined || ev.sessionId === sessionId) &&
      (hostId === ALL_HOSTS || ev.hostId === hostId),
  );
}

/** Subscribe to live events. Returns an unsubscribe function. */
export function activityMirrorSubscribe(listener: (event: AgentMirrorEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook: drop everything. Not used by production code paths. */
export function resetActivityMirror(): void {
  ring.length = 0;
  ringBytes = 0;
  nextSeq = 1;
  listeners.clear();
}
