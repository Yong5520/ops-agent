import { describe, it, expect, beforeEach, vi } from 'vitest';

// Phase 2 (issues 3 & 5): agentStore's IPC handlers must not write to shared
// sessionStore state (todos / messages / contextUsage) when the event belongs
// to a session the user is no longer viewing. This harness captures the
// callbacks registered via window.opsAgent.agent.onXxx so we can simulate
// events arriving for a background run while the user views a different session.

import { useAgentStore } from '../agentStore.js';
import { useSessionStore } from '../sessionStore.js';

type Handler = (event: Record<string, unknown>) => void;
interface Captured {
  onTextStream?: Handler;
  onThinkingStream?: Handler;
  onToolCall?: Handler;
  onToolResult?: Handler;
  onAuthorizationRequest?: Handler;
  onComplete?: Handler;
  onError?: Handler;
  onTodosUpdate?: Handler;
  onContextUsage?: Handler;
  onSteerConsumed?: Handler;
}

function installWindowMock(captured: Captured) {
  const noopUnsub = () => {};
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    opsAgent: {
      agent: {
        run: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
        respondAuthorization: vi.fn().mockResolvedValue(undefined),
        onTextStream: (cb: Handler) => {
          captured.onTextStream = cb;
          return noopUnsub;
        },
        onThinkingStream: (cb: Handler) => {
          captured.onThinkingStream = cb;
          return noopUnsub;
        },
        onToolCall: (cb: Handler) => {
          captured.onToolCall = cb;
          return noopUnsub;
        },
        onToolResult: (cb: Handler) => {
          captured.onToolResult = cb;
          return noopUnsub;
        },
        onAuthorizationRequest: (cb: Handler) => {
          captured.onAuthorizationRequest = cb;
          return noopUnsub;
        },
        onComplete: (cb: Handler) => {
          captured.onComplete = cb;
          return noopUnsub;
        },
        onError: (cb: Handler) => {
          captured.onError = cb;
          return noopUnsub;
        },
        onTodosUpdate: (cb: Handler) => {
          captured.onTodosUpdate = cb;
          return noopUnsub;
        },
        onContextUsage: (cb: Handler) => {
          captured.onContextUsage = cb;
          return noopUnsub;
        },
        onSteerConsumed: (cb: Handler) => {
          captured.onSteerConsumed = cb;
          return noopUnsub;
        },
      },
      sessions: {
        addMessage: vi.fn(),
        update: vi.fn(),
        messages: vi.fn().mockResolvedValue([]),
      },
      tasks: { list: vi.fn().mockResolvedValue([]) },
    },
  };
}

async function startRunFor(sessionId: string, captured: Captured) {
  await useAgentStore.getState().startRun({
    sessionId,
    userMessage: 'do thing',
    hostIds: ['h1'],
    safetyMode: 'operator',
  });
  return captured;
}

function viewSession(sessionId: string) {
  useSessionStore.setState({
    currentSession: {
      id: sessionId,
      title: sessionId,
      hostIds: [],
      safetyMode: 'operator',
      status: 'active',
      createdAt: '',
      updatedAt: '',
    } as never,
  });
}

describe('Phase 2: agentStore session-scoped event handling (issues 3 & 5)', () => {
  let captured: Captured;

  beforeEach(async () => {
    captured = {};
    installWindowMock(captured);
    useAgentStore.getState().reset();
    useSessionStore.setState({ messages: [], todos: [] });
    viewSession('sess-A');
  });

  it('onTodosUpdate writes todos when viewing the running session', async () => {
    await startRunFor('sess-A', captured);
    captured.onTodosUpdate!({
      sessionId: 'sess-A',
      todos: [{ id: 't1', subject: 'x', description: '', status: 'pending' }],
    });
    expect(useSessionStore.getState().todos).toHaveLength(1);
  });

  it('onTodosUpdate does NOT overwrite todos when viewing a different session (issue 3)', async () => {
    await startRunFor('sess-A', captured);
    // Seed session B's todos (the session the user switched to).
    useSessionStore.setState({
      todos: [{ id: 'b1', subject: 'b-task', description: '', status: 'pending' }],
    });
    viewSession('sess-B');
    // Session A (still running in background) emits a TodoWrite update.
    captured.onTodosUpdate!({
      sessionId: 'sess-A',
      todos: [{ id: 'a1', subject: 'a-task', description: '', status: 'pending' }],
    });
    // B's todos must be untouched.
    expect(useSessionStore.getState().todos).toEqual([
      { id: 'b1', subject: 'b-task', description: '', status: 'pending' },
    ]);
  });

  it('onComplete adds the assistant message when viewing the running session', async () => {
    await startRunFor('sess-A', captured);
    useSessionStore.setState({ messages: [] });
    captured.onComplete!({ sessionId: 'sess-A', finalMessage: 'done' });
    expect(useSessionStore.getState().messages).toHaveLength(1);
    expect(useSessionStore.getState().messages[0].content).toBe('done');
  });

  it('onComplete does NOT add a message when viewing a different session (issue 5 variant)', async () => {
    await startRunFor('sess-A', captured);
    viewSession('sess-B');
    useSessionStore.setState({ messages: [] });
    captured.onComplete!({ sessionId: 'sess-A', finalMessage: 'done' });
    expect(useSessionStore.getState().messages).toEqual([]);
    // The run still ends (isRunning cleared) so the backend state is freed.
    expect(useAgentStore.getState().isRunning).toBe(false);
  });

  it('onError does NOT add an error message when viewing a different session', async () => {
    await startRunFor('sess-A', captured);
    viewSession('sess-B');
    useSessionStore.setState({ messages: [] });
    captured.onError!({ sessionId: 'sess-A', message: 'boom' });
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useAgentStore.getState().isRunning).toBe(false);
    expect(useAgentStore.getState().error).toBe('boom');
  });

  it('clearTurn clears turn-scoped UI state but leaves the background run flag set', () => {
    // Simulate session A running, then the user switches away.
    useAgentStore.setState({
      isRunning: true,
      runningSessionId: 'sess-A',
      turnSegments: [{ kind: 'text', content: 'partial' }],
      toolCards: [
        {
          toolCallId: 'tc1',
          toolName: 'exec',
          commandType: 'READ',
          status: 'pending',
          authorization: 'auto',
        },
      ],
      pendingAuths: [
        {
          toolCallId: 'tc1',
          toolName: 'exec',
          hostName: 'h',
          hostIp: '1',
          command: 'ls',
          commandType: 'READ',
          safetyMode: 'operator',
        },
      ],
    });
    useAgentStore.getState().clearTurn();
    expect(useAgentStore.getState().turnSegments).toEqual([]);
    expect(useAgentStore.getState().toolCards).toEqual([]);
    // pendingAuths is PRESERVED: an authorization request is a one-shot event,
    // so clearing it on switch would orphan the backend's pending promise
    // (the user couldn't approve after switching back). Only Stop (cancelRun)
    // clears pendingAuths.
    expect(useAgentStore.getState().pendingAuths).toHaveLength(1);
    // isRunning/runningSessionId untouched so the background run keeps streaming.
    expect(useAgentStore.getState().isRunning).toBe(true);
    expect(useAgentStore.getState().runningSessionId).toBe('sess-A');
  });
});
