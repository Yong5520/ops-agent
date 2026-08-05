import { create } from 'zustand';
import type { SafetyMode, ThinkingBlock } from '../../shared/types.js';
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

  // Actions
  startRun: (params: {
    sessionId: string;
    userMessage: string;
    hostIds: string[];
    safetyMode: SafetyMode;
    attachments?: AgentAttachmentInput[];
  }) => Promise<void>;
  cancelRun: (sessionId: string) => Promise<void>;
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
  clearError: () => void;
}

// Unsubscribe functions for IPC event listeners
let unsubscribers: Array<() => void> = [];
// Coalesced text scheduler for the active run. Module-scoped so cancelRun
// (a separate store action) can flush pending text before capturing partial
// output. Null when no run is active.
let textScheduler: BatchScheduler<string> | null = null;
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

export const useAgentStore = create<AgentStore>((set, get) => ({
  isRunning: false,
  runningSessionId: null,
  turnSegments: [],
  toolCards: [],
  pendingAuths: [],
  error: null,
  contextUsage: null,

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
        if (content) {
          useSessionStore.getState().addMessage({
            id: `msg-assistant-${Date.now()}`,
            sessionId: params.sessionId,
            role: 'assistant',
            content,
            thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
            createdAt: new Date().toISOString(),
          });
        }
        set({ isRunning: false, runningSessionId: null, turnSegments: [], toolCards: [] });
        for (const unsub of unsubscribers) unsub();
        unsubscribers = [];

        // Auto-name session from first user message if untitled.
        // Fires after UI cleanup so the screen updates immediately.
        // Simple truncation — no AI involvement (reliable, always works).
        void autoNameSession(params.sessionId, params.userMessage);
      }),
    );

    unsubscribers.push(
      window.opsAgent.agent.onError((event) => {
        if (event.sessionId !== params.sessionId) return;
        // Flush pending text before clearing so it isn't re-injected into the
        // cleared turnSegments by the dispose in the teardown loop.
        flushPendingText();
        // Add error as a system message so it's visible in the chat history
        useSessionStore.getState().addMessage({
          id: `msg-error-${Date.now()}`,
          sessionId: params.sessionId,
          role: 'system',
          content: `[错误] ${event.message}`,
          createdAt: new Date().toISOString(),
        });
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
        useSessionStore.getState().setTodos(event.todos);
      }),
    );

    unsubscribers.push(
      window.opsAgent.agent.onContextUsage((event) => {
        if (event.sessionId !== params.sessionId) return;
        set({
          contextUsage: {
            usedTokens: event.usedTokens,
            totalTokens: event.totalTokens,
            percentage: event.percentage,
          },
        });
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
    const { text: partialText, thinkingBlocks } = extractFromSegments(get().turnSegments);
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
    set({ isRunning: false, runningSessionId: null, turnSegments: [], toolCards: [] });
    for (const unsub of unsubscribers) unsub();
    unsubscribers = [];
    try {
      await window.opsAgent.agent.cancel(sessionId);
    } catch {
      // best-effort — the loop may already be gone
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
    });
    for (const unsub of unsubscribers) unsub();
    unsubscribers = [];
  },

  clearError: () => set({ error: null }),
}));
