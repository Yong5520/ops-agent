import { create } from 'zustand';

// AI Activity Terminal store (Feature 1: read-only mirror).
//
// The AI continues to execute commands through its existing stateless
// `conn.exec` path (zero changes). This store is a passive, in-memory log of
// the tool-call / tool-result events that already flow to the renderer. The
// `AiActivityTerminal` component subscribes to `window.opsAgent.agent.onToolCall`
// / `onToolResult` and forwards them here via `recordToolCall` / `recordToolResult`.
//
// Keeping the log in the store (rather than only inside xterm) lets the panel
// replay history when the user switches the watched host, and keeps the store
// unit-testable without any DOM dependency.

// Hosts the AI runs on directly carry `hostId`. exec_multi on multiple hosts
// emits an aggregate card with no hostId (hostName = "N hosts") - attribute
// those to this synthetic bucket so they still appear in the "全部主机" view.
export const MULTI_HOST_BUCKET = '__multi__';

export interface ActivityCommand {
  kind: 'command';
  seq: number;
  sessionId: string;
  toolCallId: string;
  hostId: string;
  hostName: string;
  toolName: string;
  command: string;
  description?: string;
  commandType: string;
}

export interface ActivityChunk {
  kind: 'chunk';
  seq: number;
  sessionId: string;
  toolCallId: string;
  hostId: string;
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface ActivityFinal {
  kind: 'final';
  seq: number;
  sessionId: string;
  toolCallId: string;
  hostId: string;
  success: boolean;
  exitCode: number | null;
  durationMs?: number;
  // Fallback output, only written when no partial chunks were observed for
  // this toolCallId (e.g. a fast command or exec_multi aggregate summary).
  stdout?: string;
  stderr?: string;
  blockedReason?: string;
}

export type ActivityEvent = ActivityCommand | ActivityChunk | ActivityFinal;

// Bound memory: keep the most recent events. xterm's own scrollback is also
// bounded, so the live terminal never grows unbounded regardless.
const MAX_EVENTS = 500;

interface PendingCommand {
  sessionId: string;
  hostId: string;
  hadPartial: boolean;
}

// Sentinel meaning "show activity for every host bucket".
export const ALL_HOSTS = '__all__';

interface ActivityTerminalStore {
  isOpen: boolean;
  // Currently watched host id, or ALL_HOSTS. Defaults to ALL_HOSTS so the user
  // sees AI activity immediately without picking a host first.
  selectedHostId: string;
  events: ActivityEvent[];

  open: () => void;
  close: () => void;
  selectHost: (hostId: string) => void;
  clear: () => void;

  // Forwarded from the renderer's agent event listeners. Pure data handling -
  // no IPC, no DOM. Safe to call from tests.
  recordToolCall: (event: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    hostId?: string;
    hostName?: string;
    command?: string;
    description?: string;
    commandType: string;
  }) => void;
  recordToolResult: (event: {
    toolCallId: string;
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    durationMs?: number;
    blockedReason?: string;
    partial?: boolean;
  }) => void;
}

interface State {
  isOpen: boolean;
  selectedHostId: string;
  events: ActivityEvent[];
  pending: Map<string, PendingCommand>;
  nextSeq: number;
}

// Trim the oldest events once the cap is exceeded. Returns a new array (no
// mutation) to keep the store state immutable per the project's coding style.
function trim(events: ActivityEvent[]): ActivityEvent[] {
  if (events.length <= MAX_EVENTS) return events;
  return events.slice(events.length - MAX_EVENTS);
}

export const useActivityTerminalStore = create<ActivityTerminalStore>((set) => {
  const state: State = {
    isOpen: false,
    selectedHostId: ALL_HOSTS,
    events: [],
    pending: new Map(),
    nextSeq: 1,
  };

  const append = (ev: ActivityEvent) => {
    state.events = trim([...state.events, ev]);
    // Mutate the Map in place - it is not part of the reactive state surface
    // (only `events` is selected by components), so this avoids needless
    // allocations on the hot streaming path.
    set({ events: state.events });
  };

  return {
    isOpen: state.isOpen,
    selectedHostId: state.selectedHostId,
    events: state.events,

    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
    selectHost: (hostId) => set({ selectedHostId: hostId }),
    clear: () => {
      state.events = [];
      state.pending.clear();
      set({ events: [] });
    },

    recordToolCall: (event) => {
      // Only mirror tools that actually run a shell command on a host. Tools
      // without a `command` field (list_hosts, todo_write, ask_user, ...) are
      // ignored - they produce no terminal output to display.
      if (!event.command) return;
      const hostId = event.hostId ?? MULTI_HOST_BUCKET;
      state.pending.set(event.toolCallId, {
        sessionId: event.sessionId,
        hostId,
        hadPartial: false,
      });
      append({
        kind: 'command',
        seq: state.nextSeq++,
        sessionId: event.sessionId,
        toolCallId: event.toolCallId,
        hostId,
        hostName: event.hostName ?? (hostId === MULTI_HOST_BUCKET ? '多主机' : hostId),
        toolName: event.toolName,
        command: event.command,
        description: event.description,
        commandType: event.commandType,
      });
    },

    recordToolResult: (event) => {
      const pending = state.pending.get(event.toolCallId);
      // Ignore results without a matching command header. This gracefully
      // drops exec_multi per-host partial cards (their toolCallId is a
      // `${base}__${host}` suffix that never had a command event) so they
      // don't dangle in the mirror without a prompt line.
      if (!pending) return;

      if (event.partial) {
        pending.hadPartial = true;
        const stream: 'stdout' | 'stderr' =
          event.stderr !== undefined && event.stdout === undefined ? 'stderr' : 'stdout';
        append({
          kind: 'chunk',
          seq: state.nextSeq++,
          sessionId: pending.sessionId,
          toolCallId: event.toolCallId,
          hostId: pending.hostId,
          stream,
          data: event.stdout ?? event.stderr ?? '',
        });
        return;
      }

      // Final result. If no partial chunks were streamed, emit the full
      // stdout/stderr once so fast commands still show their output.
      state.pending.delete(event.toolCallId);
      append({
        kind: 'final',
        seq: state.nextSeq++,
        sessionId: pending.sessionId,
        toolCallId: event.toolCallId,
        hostId: pending.hostId,
        success: event.success,
        exitCode: event.exitCode ?? null,
        durationMs: event.durationMs,
        stdout: pending.hadPartial ? undefined : event.stdout,
        stderr: pending.hadPartial ? undefined : event.stderr,
        blockedReason: event.blockedReason,
      });
    },
  };
});

// Does an event belong to the currently watched host view? `ALL_HOSTS` matches
// everything (including the multi-host bucket); a specific host matches only
// its own bucket. Pure helper, exported for the component and tests.
export function eventMatchesHost(event: ActivityEvent, selectedHostId: string): boolean {
  if (selectedHostId === ALL_HOSTS) return true;
  return event.hostId === selectedHostId;
}
