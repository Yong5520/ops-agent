import { create } from 'zustand';
import type { SafetyMode } from '../../shared/types.js';
import { useSessionStore } from './sessionStore.js';

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
  // Accumulated streaming text for the current assistant response
  streamingText: string;
  // Tool call cards for the current turn
  toolCards: ToolCallCard[];
  // Pending authorization requests waiting for user response
  pendingAuths: PendingAuthorization[];
  // Error message if the loop failed
  error: string | null;

  // Actions
  startRun: (params: {
    sessionId: string;
    userMessage: string;
    hostIds: string[];
    safetyMode: SafetyMode;
  }) => Promise<void>;
  cancelRun: (sessionId: string) => Promise<void>;
  respondAuth: (
    toolCallId: string,
    approved: boolean,
    reason?: string,
    backup?: boolean,
  ) => Promise<void>;
  reset: () => void;
  clearError: () => void;
}

// Unsubscribe functions for IPC event listeners
let unsubscribers: Array<() => void> = [];

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

export const useAgentStore = create<AgentStore>((set, get) => ({
  isRunning: false,
  streamingText: '',
  toolCards: [],
  pendingAuths: [],
  error: null,

  startRun: async (params) => {
    set({ isRunning: true, streamingText: '', toolCards: [], error: null });

    // Subscribe to events for this run
    unsubscribers.push(
      window.opsAgent.agent.onTextStream((event) => {
        if (event.sessionId === params.sessionId) {
          set({ streamingText: get().streamingText + event.text });
        }
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
        set({ toolCards: [...get().toolCards, card] });
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
        // Capture streaming text BEFORE clearing it, and add it as an
        // assistant message to the session store so it persists in the UI.
        const finalText = get().streamingText || event.finalMessage;
        if (finalText) {
          useSessionStore.getState().addMessage({
            id: `msg-assistant-${Date.now()}`,
            sessionId: params.sessionId,
            role: 'assistant',
            content: finalText,
            createdAt: new Date().toISOString(),
          });
        }
        set({ isRunning: false, streamingText: '', toolCards: [] });
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
        // Add error as a system message so it's visible in the chat history
        useSessionStore.getState().addMessage({
          id: `msg-error-${Date.now()}`,
          sessionId: params.sessionId,
          role: 'system',
          content: `[错误] ${event.message}`,
          createdAt: new Date().toISOString(),
        });
        set({ isRunning: false, error: event.message, streamingText: '', toolCards: [] });
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

    // Initiate the run
    try {
      await window.opsAgent.agent.run({
        sessionId: params.sessionId,
        userMessage: params.userMessage,
        hostIds: params.hostIds,
        safetyMode: params.safetyMode,
      });
    } catch (err) {
      const msg = (err as Error).message;
      useSessionStore.getState().addMessage({
        id: `msg-error-${Date.now()}`,
        sessionId: params.sessionId,
        role: 'system',
        content: `[错误] ${msg}`,
        createdAt: new Date().toISOString(),
      });
      set({ isRunning: false, error: msg, streamingText: '', toolCards: [] });
      for (const unsub of unsubscribers) unsub();
      unsubscribers = [];
    }
  },

  cancelRun: async (sessionId) => {
    // Capture partial streaming text BEFORE calling cancel. The agent loop's
    // onComplete also fires on abort, but the IPC cancel call is async and we
    // want the UI to feel snappy — we save the partial text locally here and
    // let the main process loop complete on its own. The onComplete handler
    // is a no-op for already-saved text because streamingText is reset.
    const partialText = get().streamingText;
    if (partialText) {
      useSessionStore.getState().addMessage({
        id: `msg-assistant-${Date.now()}`,
        sessionId,
        role: 'assistant',
        content: partialText,
        createdAt: new Date().toISOString(),
      });
    }
    set({ isRunning: false, streamingText: '', toolCards: [] });
    for (const unsub of unsubscribers) unsub();
    unsubscribers = [];
    try {
      await window.opsAgent.agent.cancel(sessionId);
    } catch {
      // best-effort — the loop may already be gone
    }
  },

  respondAuth: async (toolCallId, approved, reason, backup) => {
    await window.opsAgent.agent.respondAuthorization({ toolCallId, approved, reason, backup });
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
    set({ isRunning: false, streamingText: '', toolCards: [], pendingAuths: [], error: null });
    for (const unsub of unsubscribers) unsub();
    unsubscribers = [];
  },

  clearError: () => set({ error: null }),
}));
