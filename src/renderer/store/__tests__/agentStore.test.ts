import { describe, it, expect, beforeEach, vi } from 'vitest';

// agentStore touches window.opsAgent only inside action bodies (not at module
// eval), so we can import the store safely and stub window per-test.

import { useAgentStore } from '../agentStore.js';
import { useSessionStore } from '../sessionStore.js';

// Minimal PendingAuthorization shape for the test.
const pendingAuth = {
  toolCallId: 'tc-1',
  toolName: 'exec',
  hostName: 'host1',
  hostIp: '1.2.3.4',
  command: 'ls -la',
  commandType: 'READ' as const,
  safetyMode: 'operator' as const,
};

describe('useAgentStore.cancelRun', () => {
  let cancelMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cancelMock = vi.fn().mockResolvedValue(undefined);
    // Stub the IPC surface cancelRun actually touches. addMessage is only
    // called when partial streamed text exists (it doesn't here).
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      opsAgent: {
        agent: { cancel: cancelMock },
        sessions: { addMessage: vi.fn(), update: vi.fn() },
      },
    };

    useAgentStore.setState({
      isRunning: true,
      runningSessionId: 'sess-1',
      turnSegments: [],
      toolCards: [],
      pendingAuths: [pendingAuth],
      error: null,
      contextUsage: null,
    });
  });

  it('clears pendingAuths so the AuthDialog closes on Stop (issue 1e)', async () => {
    expect(useAgentStore.getState().pendingAuths).toHaveLength(1);
    await useAgentStore.getState().cancelRun('sess-1');
    // The bug: cancelRun used to leave pendingAuths populated, so the
    // authorization dialog stayed open after the user clicked Stop.
    expect(useAgentStore.getState().pendingAuths).toEqual([]);
    expect(useAgentStore.getState().isRunning).toBe(false);
    expect(useAgentStore.getState().runningSessionId).toBeNull();
  });

  it('still calls the agent.cancel IPC', async () => {
    await useAgentStore.getState().cancelRun('sess-1');
    expect(cancelMock).toHaveBeenCalledWith('sess-1');
  });
});

describe('useAgentStore.steerMessage (Phase 3 queued steers)', () => {
  let steerMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    steerMock = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      opsAgent: {
        agent: { steer: steerMock },
        sessions: { addMessage: vi.fn(), update: vi.fn() },
      },
    };
    useSessionStore.setState({ messages: [], currentSession: { id: 'sess-1' } as never });
    useAgentStore.setState({ pendingSteersBySession: {} });
  });

  it('queues the steer as pending (NOT in the message list) and calls agent.steer with a msgId', async () => {
    await useAgentStore.getState().steerMessage('sess-1', '别重启，先看日志');

    // NOT shown as a normal message yet - it is queued pending the next round.
    expect(useSessionStore.getState().messages).toEqual([]);
    // Held in the per-session pending queue.
    const pending = useAgentStore.getState().pendingSteersBySession['sess-1'];
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toBe('别重启，先看日志');
    // Enqueued via the steer IPC with the same msgId used in the pending entry.
    expect(steerMock).toHaveBeenCalledTimes(1);
    const [sid, text, msgId] = steerMock.mock.calls[0];
    expect(sid).toBe('sess-1');
    expect(text).toBe('别重启，先看日志');
    expect(typeof msgId).toBe('string');
    expect(pending[0].msgId).toBe(msgId);
  });

  it('ignores empty/whitespace-only steer messages', async () => {
    await useAgentStore.getState().steerMessage('sess-1', '   ');
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useAgentStore.getState().pendingSteersBySession['sess-1']).toBeUndefined();
    expect(steerMock).not.toHaveBeenCalled();
  });
});

describe('useAgentStore.consumeSteers', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      opsAgent: { agent: {}, sessions: { addMessage: vi.fn(), update: vi.fn() } },
    };
    useSessionStore.setState({ messages: [], currentSession: { id: 'sess-1' } as never });
  });

  it('moves consumed steers from pending into the message list when viewing the session', () => {
    useAgentStore.setState({
      pendingSteersBySession: {
        'sess-1': [
          { msgId: 'm1', text: '改用方法 Y' },
          { msgId: 'm2', text: '再看一眼日志' },
        ],
      },
    });

    useAgentStore.getState().consumeSteers('sess-1', ['m1']);

    // m1 moved into the message list as a normal user bubble.
    const msgs = useSessionStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('m1');
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('改用方法 Y');
    // m2 stays pending.
    const pending = useAgentStore.getState().pendingSteersBySession['sess-1'];
    expect(pending).toEqual([{ msgId: 'm2', text: '再看一眼日志' }]);
  });

  it('does not add to the message list when not viewing the session (steers are in the DB)', () => {
    useSessionStore.setState({ currentSession: { id: 'other' } as never });
    useAgentStore.setState({
      pendingSteersBySession: { 'sess-1': [{ msgId: 'm1', text: 'hi' }] },
    });

    useAgentStore.getState().consumeSteers('sess-1', ['m1']);

    expect(useSessionStore.getState().messages).toEqual([]);
    // Pending cleared either way (the steer was consumed; the DB already has it
    // and will load on switch-back).
    expect(useAgentStore.getState().pendingSteersBySession['sess-1']).toEqual([]);
  });
});

describe('useAgentStore.flushPendingSteers', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      opsAgent: { agent: {}, sessions: { addMessage: vi.fn(), update: vi.fn() } },
    };
    useSessionStore.setState({ messages: [], currentSession: { id: 'sess-1' } as never });
  });

  it('moves ALL remaining pending steers into the message list (run-end flush)', () => {
    useAgentStore.setState({
      pendingSteersBySession: {
        'sess-1': [
          { msgId: 'm1', text: 'first' },
          { msgId: 'm2', text: 'second' },
        ],
      },
    });

    useAgentStore.getState().flushPendingSteers('sess-1');

    const msgs = useSessionStore.getState().messages;
    expect(msgs.map((m) => m.content)).toEqual(['first', 'second']);
    expect(useAgentStore.getState().pendingSteersBySession['sess-1']).toEqual([]);
  });

  it('is a no-op when there are no pending steers', () => {
    useAgentStore.setState({ pendingSteersBySession: {} });
    useAgentStore.getState().flushPendingSteers('sess-1');
    expect(useSessionStore.getState().messages).toEqual([]);
  });

  it('clears pending but does not add messages when not viewing the session', () => {
    useSessionStore.setState({ currentSession: { id: 'other' } as never });
    useAgentStore.setState({
      pendingSteersBySession: { 'sess-1': [{ msgId: 'm1', text: 'hi' }] },
    });

    useAgentStore.getState().flushPendingSteers('sess-1');

    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useAgentStore.getState().pendingSteersBySession['sess-1']).toEqual([]);
  });
});
