import { create } from 'zustand';
import type { SafetyMode, ThinkingBlock, SteerEntry } from '../../shared/types.js';
import { useSessionStore } from './sessionStore.js';
import { appendTextToSegments, retractTextFromSegments } from './segment-helpers.js';
import { createBatchScheduler, type BatchScheduler } from '../lib/event-throttle.js';

// Tool call card displayed in the chat UI alongside messages.
export interface ToolCallCard {
  toolCallId: string;
  toolName: string;
  hostName?: string;
  command?: string;
  description?: string;
  commandType: 'READ' | 'WRITE' | 'SUDO' | 'BLOCKED';
  status: 'pending' | 'executing' | 'success' | 'failed' | 'blocked' | 'awaiting-approval';
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
  blockedReason?: string;
  authorization: 'auto' | 'approved' | 'rejected' | 'blocked';
}

// Ordered segments of the current assistant turn, captured in arrival order so
// the UI can interleave thinking blocks, tool calls, and answer text
// chronologically (Claude Code style). Reset on each run.
export interface ThinkingTurnSegment {
  kind: 'thinking';
  blockId: string;
  content: string;
  durationMs?: number;
  streaming: boolean; // true while the block is still receiving deltas
}
export interface TextTurnSegment {
  kind: 'text';
  content: string;
}
export interface ToolTurnSegment {
  kind: 'tool';
  toolCallId: string; // references a ToolCallCard by id
}
export type TurnSegment = ThinkingTurnSegment | TextTurnSegment | ToolTurnSegment;

// Authorization request awaiting user response.
export interface PendingAuthorization {
  toolCallId: string;
  toolName: string;
  hostName: string;
  hostIp: string;
  command: string;
  description?: string;
  commandType: 'READ' | 'WRITE' | 'SUDO' | 'BLOCKED';
  safetyMode: SafetyMode;
  backupPaths?: string[];
}

interface AgentStore {
  // Whether the agent loop is running for the current session
  isRunning: boolean;
  // The sessionId whose loop is currently running (null when idle). Used to
  // scope the live-turn overlay to the running session so switching to a
  // different session mid-run shows that session cleanly instead of the old
  // run's streaming state overlaid.
  runningSessionId: string | null;
  // Ordered segments of the current assistant turn (thinking/text/tool),
  // captured in arrival order for chronological interleaved rendering.
  turnSegments: TurnSegment[];
  // Tool call cards for the current turn
  toolCards: ToolCallCard[];
  // Pending authorization requests waiting for user response
  pendingAuths: PendingAuthorization[];
  // Error message if the loop failed
  error: string | null;
  // Context usage from the last API finish event
  contextUsage: { usedTokens: number; totalTokens: number; percentage: number } | null;
  // Phase 3: queued steer messages the user typed mid-run, keyed by session.
  // Shown as pending `❯` prompts (not normal message bubbles) until the loop
  // drains them (agent:steer-consumed) or the run ends - then they move into
  // the message list. Per-session so a background run's pending steers survive
  // a session switch and reappear when the user switches back.
  pendingSteersBySession: Record<string, SteerEntry[]>;

  // Actions
  startRun: (params: {
    sessionId: string;
    userMessage: string;
    hostIds: string[];
    safetyMode: SafetyMode;
    attachments?: AgentAttachmentInput[];
  }) => Promise<void>;
  cancelRun: (sessionId: string) => Promise<void>;
  // Phase 3: enqueue a steer message typed mid-run to redirect the task. The
  // message is persisted by the IPC handler and drained by the loop before the
  // next streamText round. Held in pendingSteers (NOT the message list) until
  // the loop drains it (consumeSteers via agent:steer-consumed) or the run ends
  // (flushPendingSteers), so it shows as a queued `❯` prompt instead of looking
  // like a message that was already sent.
  steerMessage: (sessionId: string, message: string) => Promise<void>;
  // Phase 3: move the given consumed steers from pending into the message list
  // (only when viewing the session; otherwise the DB copy loads on switch-back).
  consumeSteers: (sessionId: string, msgIds: string[]) => void;
  // Phase 3: move ALL remaining pending steers into the message list. Called on
  // run end (complete/error/cancel) so unconsumed steers become normal messages
  // (they were already persisted; the next run sees them as history).
  flushPendingSteers: (sessionId: string) => void;
  respondAuth: (
    toolCallId: string,
    approved: boolean,
    reason?: string,
    backup?: boolean,
    // User-edited command (Phase A): when set, replaces the model's command
    // after security re-validation. Only meaningful for exec/sudo_exec.
    editedCommand?: string,
    // Phase B: when true (with approved=false), the user clicked "拒绝并停止" -
    // reject this command and stop the task (loop breaks + wind-down turn).
    stopRequested?: boolean,
  ) => Promise<void>;
  reset: () => void;
  // Clear the turn-scoped UI state (turnSegments / toolCards / pendingAuths)
  // WITHOUT touching isRunning / runningSessionId. Called on session switch so
  // the newly-selected session's view is clean - the previous session's run
  // keeps streaming in the background, but its live-turn overlay no longer
  // shows in the now-current session's message list (issues 3 & 5).
  clearTurn: () => void;
  clearError: () => void;
}

// Unsubscribe functions for IPC event listeners
let unsubscribers: Array<() => void> = [];
// Coalesced text scheduler for the active run. Module-scoped so cancelRun
// (a separate store action) can flush pending text before capturing partial
// output. Null when no run is active.
let textScheduler: BatchScheduler<string> | null = null;
// Monotonic counter for steer msgIds so two steers sent in the same millisecond
// still get distinct ids (the pending queue and the steer-consumed event match
// on msgId).
let steerIdCounter = 0;
// Flush any pending coalesced text into turnSegments. No-op when no scheduler.
function flushPendingText(): void {
  textScheduler?.dispose();
  textScheduler = null;
}

// Auto-name a session from the first user message if it has no title.
// Called after the first agent exchange completes. Simple truncation —
// no AI involvement (reliable, always works). Non-fatal: if the IPC
// update fails, the session simply keeps its default title.
async function autoNameSession(sessionId: string, userMessage: string): Promise<void> {
  const { currentSession } = useSessionStore.getState();
  // Only auto-name if this is the current session and it has no title yet.
  if (!currentSession || currentSession.id !== sessionId || currentSession.title) {
    return;
  }
  const autoTitle = userMessage.slice(0, 40).replace(/\s+/g, ' ').trim() || '新会话';
  try {
    const updated = await window.opsAgent.sessions.update(sessionId, { title: autoTitle });
    // Refresh both currentSession and the sessions list so the sidebar
    // reflects the new title immediately.
    useSessionStore.setState({
      currentSession: updated,
      sessions: useSessionStore.getState().sessions.map((s) => (s.id === sessionId ? updated : s)),
    });
  } catch {
    // Non-fatal — session keeps default title
  }
}

// Extract the concatenated answer text and finalized thinking blocks from a
// turn's segments. Used to persist the local assistant message on
// complete/cancel so the immediate display matches the DB-saved version.
function extractFromSegments(segments: TurnSegment[]): {
  text: string;
  thinkingBlocks: ThinkingBlock[];
} {
  let text = '';
  const thinkingBlocks: ThinkingBlock[] = [];
  for (const seg of segments) {
    if (seg.kind === 'text') {
      text += seg.content;
    } else if (seg.kind === 'thinking' && seg.content.length > 0) {
      thinkingBlocks.push({ id: seg.blockId, content: seg.content, durationMs: seg.durationMs });
    }
  }
  return { text, thinkingBlocks };
}

// Whether the user is currently viewing the given session. IPC events for a
// background run (session A) must NOT mutate shared sessionStore state when the
// user has switched to session B - that was the root cause of the cross-session
// task-list leak (issue 3) and the message/auth leak into the wrong view
// (issue 5). Streaming-only state (turnSegments/toolCards) is hidden via
// showLiveTurn, but todos/messages/contextUsage write directly to sessionStore
// and so must be gated here.
function isViewingSession(sessionId: string): boolean {
  return useSessionStore.getState().currentSession?.id === sessionId;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  isRunning: false,
  runningSessionId: null,
  turnSegments: [],
  toolCards: [],
  pendingAuths: [],
  error: null,
  contextUsage: null,
  pendingSteersBySession: {},

  startRun: async (params) => {
    set({
      isRunning: true,
      runningSessionId: params.sessionId,
      turnSegments: [],
      toolCards: [],
      error: null,
    });

    // Subscribe to events for this run.
    //
    // Text deltas are coalesced through a batch scheduler so the store only
    // re-renders ~20x/sec instead of per token. This is what made session
    // switching feel frozen during a model flood (qwen loop): per-token set()
    // calls saturated the renderer and the click -> IPC -> state-update chain
    // couldn't commit. The scheduler flushes immediately on a large burst and
    // always flushes pending data on dispose (run end / cancel) so nothing is
    // lost.
    textScheduler = createBatchScheduler<string>({
      idleDelayMs: 50,
      maxBufferSize: 200,
      onFlush: (deltas) => {
        if (deltas.length === 0) return;
        const combined = deltas.join('');
        set((state) => ({ turnSegments: appendTextToSegments(state.turnSegments, combined) }));
      },
    });
    const scheduler = textScheduler;
    // Dispose flushes any pending coalesced text (run end / cancel / error)
    // so no streamed text is dropped. flushPendingText nulls the module ref;
    // the closure guard makes the pushed unsub safe to call more than once.
    unsubscribers.push(() => {
      scheduler.dispose();
      if (textScheduler === scheduler) textScheduler = null;
    });
    unsubscribers.push(
      window.opsAgent.agent.onTextStream((event) => {
        if (event.sessionId === params.sessionId) {
          textScheduler?.push(event.text);
        }
      }),
    );

    unsubscribers.push(
      window.opsAgent.agent.onThinkingStream((event) => {
        if (event.sessionId !== params.sessionId) return;
        set((state) => {
          let segments = state.turnSegments;
          const idx = segments.findIndex(
            (s) => s.kind === 'thinking' && s.blockId === event.blockId,
          );
          if (idx === -1) {
            // New thinking block. If the backend signalled absorbPrecedingText
            // (qwen stray-closer pattern), the reasoning was streamed as answer
            // text first - retract it from the text stream before opening the
            // thinking card so it isn't shown twice.
            if (event.absorbPrecedingText && event.absorbPrecedingText > 0) {
              segments = retractTextFromSegments(segments, event.absorbPrecedingText);
            }
            const newSeg: ThinkingTurnSegment = {
              kind: 'thinking',
              blockId: event.blockId,
              content: event.delta ?? '',
              streaming: !event.closed,
              durationMs: event.closed ? event.durationMs : undefined,
            };
            return { turnSegments: [...segments, newSeg] };
          }
          // Update existing block (append delta, finalize on close)
          const existing = segments[idx] as ThinkingTurnSegment;
          const updated: ThinkingTurnSegment = {
            ...existing,
            content: existing.content + (event.delta ?? ''),
            streaming: !event.closed,
            durationMs: event.closed ? event.durationMs : existing.durationMs,
          };
          return {
            turnSegments: [...segments.slice(0, idx), updated, ...segments.slice(idx + 1)],
          };
        });
      }),
    );

    unsubscribers.push(
      window.opsAgent.agent.onToolCall((event) => {
        if (event.sessionId !== params.sessionId) return;
        const card: ToolCallCard = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          hostName: event.hostName,
          command: event.command,
          description: event.description,
          commandType: event.commandType,
          status: event.needsApproval ? 'awaiting-approval' : 'executing',
          authorization: 'auto',
        };
        set((state) => ({
          toolCards: [...state.toolCards, card],
          turnSegments: [...state.turnSegments, { kind: 'tool', toolCallId: event.toolCallId }],
        }));
      }),
    );

    unsubscribers.push(
      window.opsAgent.agent.onToolResult((event) => {
        if (event.sessionId !== params.sessionId) return;
        set({
          toolCards: get().toolCards.map((c) => {
            if (c.toolCallId !== event.toolCallId) return c;
            // Partial results: append stdout/stderr to the existing card
            // for streaming output. Don't change the status — only the final
            // (non-partial) result sets the final status/exitCode.
            if (event.partial) {
              return {
                ...c,
                stdout: event.stdout ? (c.stdout ?? '') + event.stdout : c.stdout,
                stderr: event.stderr ? (c.stderr ?? '') + event.stderr : c.stderr,
              };
            }
            // Final result: replace with complete data
            return {
              ...c,
              status: event.success
                ? 'success'
                : event.authorization === 'blocked'
                  ? 'blocked'
                  : 'failed',
              stdout: event.stdout,
              stderr: event.stderr,
              exitCode: event.exitCode,
              durationMs: event.durationMs,
              blockedReason: event.blockedReason,
              authorization: event.authorization,
            };
          }),
        });
      }),
    );

    unsubscribers.push(
      window.opsAgent.agent.onAuthorizationRequest((event) => {
        if (event.sessionId !== params.sessionId) return;
        set({
          pendingAuths: [
            ...get().pendingAuths,
            {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              hostName: event.hostName,
              hostIp: event.hostIp,
              command: event.command,
              description: event.description,
              commandType: event.commandType,
              safetyMode: event.safetyMode,
              backupPaths: event.backupPaths,
            },
          ],
        });
      }),
    );

    unsubscribers.push(
      window.opsAgent.agent.onComplete((event) => {
        if (event.sessionId !== params.sessionId) return;
        const viewing = isViewingSession(params.sessionId);
        // Flush any coalesced text still pending in the scheduler so the
        // extract below sees the full streamed text (the authoritative
        // finalMessage is preferred, but streamedText is the fallback).
        flushPendingText();
        // Extract thinking blocks from the streamed segments so the locally
        // added message matches the DB-saved version (the backend persists
        // the same blocks). Content comes from the backend's finalMessage
        // (authoritative - includes nudge/error separators not always streamed).
        const { text: streamedText, thinkingBlocks } = extractFromSegments(get().turnSegments);
        const content = event.finalMessage || streamedText;
        // Only add to the viewed session's message list. The backend already
        // persisted the assistant message, so a background run's completion
        // must not inject its message into the session the user switched to
        // (issue 5 variant). Switching back loads it from the DB.
        if (content && viewing) {
          useSessionStore.getState().addMessage({
            id: `msg-assistant-${Date.now()}`,
            sessionId: params.sessionId,
            role: 'assistant',
            content,
            thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
            createdAt: new Date().toISOString(),
          });
        }
        // Phase 3: any steers still pending (arrived after the loop's final
        // drain) were never fed to the model this run. They are already in the
        // DB, so flush them into the message list as normal user messages -
        // they become the latest user turn for the next run.
        get().flushPendingSteers(params.sessionId);
        set({ isRunning: false, runningSessionId: null, turnSegments: [], toolCards: [] });
        for (const unsub of unsubscribers) unsub();
        unsubscribers = [];

        // Auto-name session from first user message if untitled.
        // Fires after UI cleanup so the screen updates immediately.
        // Simple truncation — no AI involvement (reliable, always works).
        void (viewing && autoNameSession(params.sessionId, params.userMessage));
      }),
    );

    unsubscribers.push(
      window.opsAgent.agent.onError((event) => {
        if (event.sessionId !== params.sessionId) return;
        const viewing = isViewingSession(params.sessionId);
        // Flush pending text before clearing so it isn't re-injected into the
        // cleared turnSegments by the dispose in the teardown loop.
        flushPendingText();
        // Only add the error message to the viewed session's list. The backend
        // records the failure; a background run's error must not surface in the
        // session the user switched to.
        if (viewing) {
          useSessionStore.getState().addMessage({
            id: `msg-error-${Date.now()}`,
            sessionId: params.sessionId,
            role: 'system',
            content: `[错误] ${event.message}`,
            createdAt: new Date().toISOString(),
          });
        }
        // Phase 3: flush unconsumed pending steers (see onComplete).
        get().flushPendingSteers(params.sessionId);
        set({
          isRunning: false,
          runningSessionId: null,
          error: event.message,
          turnSegments: [],
          toolCards: [],
        });
        for (const unsub of unsubscribers) unsub();
        unsubscribers = [];
      }),
    );

    unsubscribers.push(
      window.opsAgent.agent.onTodosUpdate((event) => {
        if (event.sessionId !== params.sessionId) return;
        // Do not overwrite the viewed session's todos with a background run's
        // task list (issue 3). The backend persists todos per-session; the
        // user sees them when they switch back (selectSession -> loadTodos).
        if (!isViewingSession(params.sessionId)) return;
        useSessionStore.getState().setTodos(event.todos);
      }),
    );

    unsubscribers.push(
      window.opsAgent.agent.onContextUsage((event) => {
        if (event.sessionId !== params.sessionId) return;
        if (!isViewingSession(params.sessionId)) return;
        set({
          contextUsage: {
            usedTokens: event.usedTokens,
            totalTokens: event.totalTokens,
            percentage: event.percentage,
          },
        });
      }),
    );

    // Phase 3: when the loop drains queued steers (feeds them to the model),
    // move them from the pending queue into the message list so they appear as
    // normal user bubbles right before the model's response to them.
    unsubscribers.push(
      window.opsAgent.agent.onSteerConsumed((event) => {
        if (event.sessionId !== params.sessionId) return;
        get().consumeSteers(params.sessionId, event.msgIds);
      }),
    );

    // Initiate the run
    try {
      await window.opsAgent.agent.run({
        sessionId: params.sessionId,
        userMessage: params.userMessage,
        hostIds: params.hostIds,
        safetyMode: params.safetyMode,
        // Per-session model override. Looked up by sessionId (not currentSession)
        // so a run kicked off for a non-current session still uses its own model.
        // Undefined -> the loop falls back to the global active default.
        modelProviderId: useSessionStore.getState().sessions.find((s) => s.id === params.sessionId)
          ?.modelProviderId,
        attachments: params.attachments,
      });
    } catch (err) {
      const msg = (err as Error).message;
      // Flush pending text before clearing (see onError comment).
      flushPendingText();
      useSessionStore.getState().addMessage({
        id: `msg-error-${Date.now()}`,
        sessionId: params.sessionId,
        role: 'system',
        content: `[错误] ${msg}`,
        createdAt: new Date().toISOString(),
      });
      set({
        isRunning: false,
        runningSessionId: null,
        error: msg,
        turnSegments: [],
        toolCards: [],
      });
      for (const unsub of unsubscribers) unsub();
      unsubscribers = [];
    }
  },

  cancelRun: async (sessionId) => {
    // Capture partial streaming text BEFORE calling cancel. The agent loop's
    // onComplete also fires on abort, but the IPC cancel call is async and we
    // want the UI to feel snappy — we save the partial text locally here and
    // let the main process loop complete on its own. The onComplete handler
    // is a no-op for already-saved text because turnSegments is reset.
    // Flush pending coalesced text first so the captured partial includes it.
    flushPendingText();
    // Only capture partial text when this session is the one actually running.
    // If the user clicks Stop while viewing a session that isn't running (a
    // background run is in another session), turnSegments may hold the other
    // session's streamed text - saving it here would leak it into this
    // session's message list.
    const isRunningThisSession = get().runningSessionId === sessionId;
    const { text: partialText, thinkingBlocks } = isRunningThisSession
      ? extractFromSegments(get().turnSegments)
      : { text: '', thinkingBlocks: [] };
    if (partialText) {
      useSessionStore.getState().addMessage({
        id: `msg-assistant-${Date.now()}`,
        sessionId,
        role: 'assistant',
        content: partialText,
        thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
        createdAt: new Date().toISOString(),
      });
    }
    // Phase 3: flush unconsumed pending steers (see onComplete). Uses the
    // sessionId passed in (the running session per onCancel wiring).
    get().flushPendingSteers(sessionId);
    set({
      isRunning: false,
      runningSessionId: null,
      turnSegments: [],
      toolCards: [],
      // Clear pending authorization requests so the AuthDialog closes when the
      // user clicks Stop. Without this, a visible approval dialog lingers after
      // cancel and responding to it resolves an orphaned (already-aborted) loop.
      pendingAuths: [],
    });
    for (const unsub of unsubscribers) unsub();
    unsubscribers = [];
    try {
      await window.opsAgent.agent.cancel(sessionId);
    } catch {
      // best-effort — the loop may already be gone
    }
  },

  steerMessage: async (sessionId, message) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    // Queue the steer as pending (shown as a `❯` prompt, NOT a normal message
    // bubble yet). The IPC handler persists it to the DB immediately; the loop
    // drains the queue and injects it before the next round, at which point
    // agent:steer-consumed fires and consumeSteers moves it into the message
    // list. The renderer-assigned msgId flows back via that event so we match
    // the exact pending entry.
    const msgId = `msg-user-steer-${Date.now()}-${++steerIdCounter}`;
    const entry: SteerEntry = { msgId, text: trimmed };
    set({
      pendingSteersBySession: {
        ...get().pendingSteersBySession,
        [sessionId]: [...(get().pendingSteersBySession[sessionId] ?? []), entry],
      },
    });
    try {
      await window.opsAgent.agent.steer(sessionId, trimmed, msgId);
    } catch {
      // best-effort - the loop may have just ended; the message is still
      // persisted and will be picked up as the latest user turn next run.
    }
  },

  consumeSteers: (sessionId, msgIds) => {
    const pending = get().pendingSteersBySession[sessionId] ?? [];
    if (pending.length === 0) return;
    const consumedSet = new Set(msgIds);
    const consumed = pending.filter((s) => consumedSet.has(s.msgId));
    const remaining = pending.filter((s) => !consumedSet.has(s.msgId));
    set({
      pendingSteersBySession: { ...get().pendingSteersBySession, [sessionId]: remaining },
    });
    if (consumed.length === 0) return;
    // Only add to the viewed session's message list. A background run's consumed
    // steers are already in the DB; switching back loads them (no cross-session
    // leak into the currently-viewed session's list - issues 3 & 5 pattern).
    if (isViewingSession(sessionId)) {
      for (const s of consumed) {
        useSessionStore.getState().addMessage({
          id: s.msgId,
          sessionId,
          role: 'user',
          content: s.text,
          createdAt: new Date().toISOString(),
        });
      }
    }
  },

  flushPendingSteers: (sessionId) => {
    const pending = get().pendingSteersBySession[sessionId] ?? [];
    if (pending.length === 0) return;
    set({
      pendingSteersBySession: { ...get().pendingSteersBySession, [sessionId]: [] },
    });
    // Only add to the viewed session's message list (see consumeSteers). If not
    // viewing, the steers are already in the DB and load on switch-back.
    if (isViewingSession(sessionId)) {
      for (const s of pending) {
        useSessionStore.getState().addMessage({
          id: s.msgId,
          sessionId,
          role: 'user',
          content: s.text,
          createdAt: new Date().toISOString(),
        });
      }
    }
  },

  respondAuth: async (toolCallId, approved, reason, backup, editedCommand, stopRequested) => {
    await window.opsAgent.agent.respondAuthorization({
      toolCallId,
      approved,
      reason,
      backup,
      editedCommand,
      stopRequested,
    });
    // Remove from pending list
    set({ pendingAuths: get().pendingAuths.filter((a) => a.toolCallId !== toolCallId) });
    // Update tool card status
    set({
      toolCards: get().toolCards.map((c) =>
        c.toolCallId === toolCallId
          ? {
              ...c,
              status: approved ? 'executing' : 'failed',
              blockedReason: approved ? undefined : '用户拒绝',
            }
          : c,
      ),
    });
  },

  reset: () => {
    // Set isRunning: false FIRST, before unsubscribing IPC listeners.
    // If any unsub() throws, isRunning is still correctly reset so the
    // chat input's `disabled` prop flips back to false immediately.
    set({
      isRunning: false,
      runningSessionId: null,
      turnSegments: [],
      toolCards: [],
      pendingAuths: [],
      error: null,
      contextUsage: null,
      pendingSteersBySession: {},
    });
    for (const unsub of unsubscribers) unsub();
    unsubscribers = [];
  },

  clearTurn: () => {
    // Clear the turn-scoped live-turn UI state WITHOUT touching isRunning /
    // runningSessionId (a background run keeps streaming) and WITHOUT touching
    // pendingAuths (an authorization request is a one-shot event - if the user
    // switches away and back, the AuthDialog must still be there so they can
    // approve; clearing it here would orphan the backend's pending promise
    // until its 5-min timeout). Called on session switch (selectSession) so the
    // now-current session's message list is clean instead of showing the
    // previous session's live-turn overlay (issues 3 & 5).
    set({
      turnSegments: [],
      toolCards: [],
    });
  },

  clearError: () => set({ error: null }),
}));
