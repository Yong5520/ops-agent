import { create } from 'zustand';
import type { Session, Message, SafetyMode, TodoItem } from '../../shared/types.js';
import { useAgentStore } from './agentStore.js';

interface SessionStore {
  sessions: Session[];
  currentSession: Session | null;
  messages: Message[];
  loading: boolean;
  error: string | null;
  // Session-level settings editable from the chat header
  hostIds: string[];
  safetyMode: SafetyMode;
  // TodoWrite task list (P0-1)
  todos: TodoItem[];

  load: () => Promise<void>;
  createSession: (params?: {
    hostIds?: string[];
    safetyMode?: SafetyMode;
    title?: string;
  }) => Promise<Session>;
  selectSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  setHostIds: (hostIds: string[]) => void;
  setSafetyMode: (mode: SafetyMode) => void;
  renameSession: (id: string, title: string) => Promise<void>;
  truncateMessagesAfter: (messageId: string) => Promise<void>;
  addMessage: (msg: Message) => void;
  updateLastAssistant: (content: string) => void;
  setTodos: (todos: TodoItem[]) => void;
  loadTodos: (sessionId: string) => Promise<void>;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  currentSession: null,
  messages: [],
  loading: false,
  error: null,
  hostIds: [],
  safetyMode: 'operator',
  todos: [],

  load: async () => {
    set({ loading: true, error: null });
    try {
      const sessions = await window.opsAgent.sessions.list();
      set({ sessions, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  createSession: async (params) => {
    const session = await window.opsAgent.sessions.create({
      title: params?.title,
      hostIds: params?.hostIds,
      safetyMode: params?.safetyMode ?? 'operator',
      status: 'active',
    });
    set({
      sessions: [session, ...get().sessions],
      currentSession: session,
      messages: [],
      hostIds: params?.hostIds ?? get().hostIds,
      safetyMode: params?.safetyMode ?? 'operator',
    });
    return session;
  },

  selectSession: async (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    const messages = await window.opsAgent.sessions.messages(id);
    set({
      currentSession: session,
      messages,
      hostIds: session.hostIds ?? [],
      safetyMode: session.safetyMode,
      todos: [],
    });
    // Load saved task list for this session
    get().loadTodos(id);
  },

  deleteSession: async (id) => {
    try {
      const isCurrent = get().currentSession?.id === id;
      // Reset the agent store before deleting so that any lingering isRunning
      // flag (e.g. when the user deletes the current session mid-run) is
      // cleared. Without this, the chat input stays disabled because
      // MessageInput checks isRunning for the textarea's `disabled` prop, and
      // the Cancel button is a no-op since currentSession is null.
      if (isCurrent) {
        useAgentStore.getState().reset();
      }
      await window.opsAgent.sessions.remove(id);
      const remaining = get().sessions.filter((s) => s.id !== id);
      set({
        sessions: remaining,
        currentSession: isCurrent ? null : get().currentSession,
        messages: isCurrent ? [] : get().messages,
      });
    } catch (err) {
      // Surface IPC failures instead of letting them become unhandled
      // rejections that silently leave the session in the sidebar.
      set({ error: `删除会话失败: ${(err as Error).message}` });
    }
  },

  setHostIds: (hostIds) => {
    set({ hostIds });
    const { currentSession } = get();
    if (currentSession) {
      window.opsAgent.sessions.update(currentSession.id, { hostIds });
    }
  },

  setSafetyMode: (safetyMode) => {
    set({ safetyMode });
    const { currentSession } = get();
    if (currentSession) {
      window.opsAgent.sessions.update(currentSession.id, { safetyMode });
    }
  },

  renameSession: async (id, title) => {
    const updated = await window.opsAgent.sessions.update(id, { title });
    set({
      sessions: get().sessions.map((s) => (s.id === id ? updated : s)),
      currentSession: get().currentSession?.id === id ? updated : get().currentSession,
    });
  },

  truncateMessagesAfter: async (messageId) => {
    const { currentSession, messages } = get();
    if (!currentSession) return;
    await window.opsAgent.sessions.deleteMessagesAfter(currentSession.id, messageId);
    // Drop the edited message and everything after it from the local array
    // so the UI is ready to receive the new (re-sent) user message.
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      set({ messages: messages.slice(0, idx) });
    }
  },

  addMessage: (msg) => {
    set({ messages: [...get().messages, msg] });
  },

  // Update the streaming assistant message in place.
  updateLastAssistant: (content) => {
    const msgs = get().messages;
    const lastIdx = msgs.length - 1;
    if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant') {
      const updated = { ...msgs[lastIdx], content };
      set({ messages: [...msgs.slice(0, lastIdx), updated] });
    }
  },

  setTodos: (todos) => {
    set({ todos });
  },

  loadTodos: async (sessionId) => {
    try {
      const todos = await window.opsAgent.tasks.list(sessionId);
      set({ todos });
    } catch {
      set({ todos: [] });
    }
  },
}));
