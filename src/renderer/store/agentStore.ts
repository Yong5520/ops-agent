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
  respondAuth: (toolCallId: string, approved: boolean, reason?: string) => Promise<void>;
  reset: () => void;
  clearError: () => void;
}

// Unsubscribe functions for IPC event listeners
let unsubscribers: Array<() => void> = [];

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
          toolCards: get().toolCards.map((c) =>
            c.toolCallId === event.toolCallId
              ? {
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
                }
              : c,
          ),
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

  respondAuth: async (toolCallId, approved, reason) => {
    await window.opsAgent.agent.respondAuthorization({ toolCallId, approved, reason });
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
    for (const unsub of unsubscribers) unsub();
    unsubscribers = [];
    set({ isRunning: false, streamingText: '', toolCards: [], pendingAuths: [], error: null });
  },

  clearError: () => set({ error: null }),
}));
