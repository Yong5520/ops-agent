import { create } from 'zustand';
import type { AgentMirrorEvent } from '../../shared/activity-mirror-types.js';

// v24 AI Activity Mirror store (renderer side).
//
// Holds the raw-channel mirror events streamed from the main-process
// `activity-mirror` ring (command boundaries + UNCLEANED chunks + finals) so
// the read-only activity terminal shows exactly what the AI's exec channels
// sent and received - like a BMC console mirror. The main process owns the
// authoritative ring (survives window re-opens); this store is the per-window
// live cache, seeded by `mirrorHistory` on mount and appended by `onMirrorEvent`.

// Sentinel meaning "show activity for every host bucket".
export const ALL_HOSTS = '__all__';
// exec_multi aggregates carry no single hostId - attribute to this bucket.
export const MULTI_HOST_BUCKET = '__multi__';

interface ActivityMirrorStore {
  /** Session this window is watching ('' = every session, for the global view). */
  sessionId: string;
  /** Watched host bucket, or ALL_HOSTS. */
  selectedHostId: string;
  events: AgentMirrorEvent[];

  setSession: (sessionId: string) => void;
  selectHost: (hostId: string) => void;
  /** Seed/replace the buffer (used on mount via mirrorHistory replay). */
  setEvents: (events: AgentMirrorEvent[]) => void;
  /** Append one live event (from onMirrorEvent). No-op if stale (seq already seen). */
  append: (event: AgentMirrorEvent) => void;
  clear: () => void;
}

const MAX_EVENTS = 500;

function trim(events: AgentMirrorEvent[]): AgentMirrorEvent[] {
  if (events.length <= MAX_EVENTS) return events;
  return events.slice(events.length - MAX_EVENTS);
}

export const useActivityMirrorStore = create<ActivityMirrorStore>((set, get) => ({
  sessionId: '',
  selectedHostId: ALL_HOSTS,
  events: [],

  setSession: (sessionId) => set({ sessionId }),
  selectHost: (hostId) => set({ selectedHostId: hostId }),
  setEvents: (events) => set({ events }),
  append: (event) => {
    const prev = get().events;
    // Drop duplicates / out-of-order replays: the main-process fan-out may
    // deliver an event that was already in the seeded history.
    if (prev.length > 0 && prev[prev.length - 1].seq >= event.seq) return;
    set({ events: trim([...prev, event]) });
  },
  clear: () => set({ events: [] }),
}));

/**
 * Does an event belong to the watched (session, host) view? ALL_HOSTS matches
 * every bucket (including the multi-host aggregate). Pure helper for the
 * component and tests.
 */
export function eventMatchesView(
  event: AgentMirrorEvent,
  sessionId: string,
  selectedHostId: string,
): boolean {
  if (sessionId !== '' && event.sessionId !== sessionId) return false;
  if (selectedHostId === ALL_HOSTS) return true;
  return event.hostId === selectedHostId;
}
