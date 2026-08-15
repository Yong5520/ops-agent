import { describe, it, expect, beforeEach } from 'vitest';
import {
  useActivityTerminalStore,
  eventMatchesHost,
  ALL_HOSTS,
  MULTI_HOST_BUCKET,
  type ActivityEvent,
} from '../activityTerminalStore.js';

// The store is a passive, in-memory log of AI tool-call/tool-result events.
// It must: attribute events to the right host bucket, track partial vs final
// results, ignore stray results without a command header, cap memory, and
// expose a pure host-matching helper. No DOM/IPC dependencies.

function call(toolCallId: string, command: string, hostId = 'h1', hostName = 'host1') {
  return {
    sessionId: 's1',
    toolCallId,
    toolName: 'exec',
    hostId,
    hostName,
    command,
    description: 'do thing',
    commandType: 'READ' as const,
  };
}

function result(
  toolCallId: string,
  opts: {
    success?: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    durationMs?: number;
    partial?: boolean;
    blockedReason?: string;
  } = {},
) {
  return {
    toolCallId,
    success: opts.success ?? true,
    stdout: opts.stdout,
    stderr: opts.stderr,
    exitCode: opts.exitCode,
    durationMs: opts.durationMs,
    partial: opts.partial,
    blockedReason: opts.blockedReason,
  };
}

describe('activityTerminalStore', () => {
  beforeEach(() => {
    useActivityTerminalStore.getState().clear();
    useActivityTerminalStore.setState({ selectedHostId: ALL_HOSTS, isOpen: false });
  });

  it('records a command event and attributes it to the host bucket', () => {
    useActivityTerminalStore.getState().recordToolCall(call('t1', 'ls -la', 'h1'));
    const events = useActivityTerminalStore.getState().events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'command',
      toolCallId: 't1',
      hostId: 'h1',
      command: 'ls -la',
    });
  });

  it('ignores tool-call events without a command field', () => {
    useActivityTerminalStore.getState().recordToolCall({
      sessionId: 's1',
      toolCallId: 't0',
      toolName: 'list_hosts',
      commandType: 'READ',
    });
    expect(useActivityTerminalStore.getState().events).toHaveLength(0);
  });

  it('attributes exec_multi (no hostId) to the multi-host bucket', () => {
    useActivityTerminalStore.getState().recordToolCall({
      sessionId: 's1',
      toolCallId: 't2',
      toolName: 'exec_multi',
      hostName: '3 hosts',
      command: 'df -h',
      commandType: 'READ',
    });
    expect(useActivityTerminalStore.getState().events[0]).toMatchObject({
      hostId: MULTI_HOST_BUCKET,
      hostName: '3 hosts',
    });
  });

  it('streams partial chunks under the command host bucket', () => {
    const { recordToolCall, recordToolResult } = useActivityTerminalStore.getState();
    recordToolCall(call('t3', 'tail -f log', 'h2', 'host2'));
    recordToolResult(result('t3', { partial: true, stdout: 'line1\n' }));
    recordToolResult(result('t3', { partial: true, stdout: 'line2\n' }));
    const events = useActivityTerminalStore.getState().events;
    expect(events.map((e) => e.kind)).toEqual(['command', 'chunk', 'chunk']);
    const chunks = events.filter((e) => e.kind === 'chunk') as Extract<
      ActivityEvent,
      { kind: 'chunk' }
    >[];
    expect(chunks.every((c) => c.hostId === 'h2' && c.stream === 'stdout')).toBe(true);
    expect(chunks.map((c) => c.data)).toEqual(['line1\n', 'line2\n']);
  });

  it('emits fallback stdout on final when no partial chunks were streamed', () => {
    const { recordToolCall, recordToolResult } = useActivityTerminalStore.getState();
    recordToolCall(call('t4', 'echo hi', 'h1'));
    recordToolResult(result('t4', { success: true, stdout: 'hi\n', exitCode: 0, durationMs: 12 }));
    const final = useActivityTerminalStore
      .getState()
      .events.find((e) => e.kind === 'final') as Extract<ActivityEvent, { kind: 'final' }>;
    expect(final.stdout).toBe('hi\n');
    expect(final.exitCode).toBe(0);
  });

  it('omits fallback stdout on final when partials were already streamed (no duplication)', () => {
    const { recordToolCall, recordToolResult } = useActivityTerminalStore.getState();
    recordToolCall(call('t5', 'tail -f', 'h1'));
    recordToolResult(result('t5', { partial: true, stdout: 'x' }));
    recordToolResult(result('t5', { success: true, stdout: 'x\n', exitCode: 0 }));
    const final = useActivityTerminalStore
      .getState()
      .events.find((e) => e.kind === 'final') as Extract<ActivityEvent, { kind: 'final' }>;
    expect(final.stdout).toBeUndefined();
  });

  it('ignores tool-result events without a matching command header (exec_multi per-host cards)', () => {
    const { recordToolResult } = useActivityTerminalStore.getState();
    recordToolResult(result('t6__hostA', { partial: true, stdout: 'whatever' }));
    expect(useActivityTerminalStore.getState().events).toHaveLength(0);
  });

  it('records a blocked final with blockedReason', () => {
    const { recordToolCall, recordToolResult } = useActivityTerminalStore.getState();
    recordToolCall(call('t7', 'rm -rf /', 'h1'));
    recordToolResult(result('t7', { success: false, blockedReason: 'blocked: dangerous' }));
    const final = useActivityTerminalStore
      .getState()
      .events.find((e) => e.kind === 'final') as Extract<ActivityEvent, { kind: 'final' }>;
    expect(final.success).toBe(false);
    expect(final.blockedReason).toBe('blocked: dangerous');
  });

  it('caps the event log to bound memory (drops oldest)', () => {
    const { recordToolCall, recordToolResult } = useActivityTerminalStore.getState();
    // Generate well over the 500-event cap.
    for (let i = 0; i < 600; i++) {
      recordToolCall(call(`t${i}`, `cmd ${i}`, 'h1'));
      recordToolResult(result(`t${i}`, { success: true, exitCode: 0 }));
    }
    const events = useActivityTerminalStore.getState().events;
    expect(events.length).toBeLessThanOrEqual(500);
    // The newest events survive; the oldest are dropped.
    const lastCommand = [...events].reverse().find((e) => e.kind === 'command') as Extract<
      ActivityEvent,
      { kind: 'command' }
    >;
    expect(lastCommand.command).toBe('cmd 599');
  });

  it('seq numbers are monotonic and never reused (safe for incremental render after trim)', () => {
    const { recordToolCall, recordToolResult, events } = useActivityTerminalStore.getState();
    for (let i = 0; i < 5; i++) {
      recordToolCall(call(`s${i}`, `c${i}`, 'h1'));
      recordToolResult(result(`s${i}`, { success: true, exitCode: 0 }));
    }
    const seqs = useActivityTerminalStore.getState().events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    void recordToolCall;
    void events;
  });

  it('clear() empties events and pending', () => {
    const { recordToolCall, recordToolResult, clear } = useActivityTerminalStore.getState();
    recordToolCall(call('t8', 'ls', 'h1'));
    recordToolResult(result('t8', { partial: true, stdout: 'x' }));
    clear();
    expect(useActivityTerminalStore.getState().events).toHaveLength(0);
    // A late result for the cleared command must not append anything.
    useActivityTerminalStore
      .getState()
      .recordToolResult(result('t8', { success: true, exitCode: 0 }));
    expect(useActivityTerminalStore.getState().events).toHaveLength(0);
  });

  describe('eventMatchesHost', () => {
    const cmd = (hostId: string): ActivityEvent => ({
      kind: 'command',
      seq: 1,
      sessionId: 's1',
      toolCallId: 'x',
      hostId,
      hostName: hostId,
      toolName: 'exec',
      command: 'ls',
      commandType: 'READ',
    });

    it('matches everything when ALL_HOSTS is selected', () => {
      expect(eventMatchesHost(cmd('h1'), ALL_HOSTS)).toBe(true);
      expect(eventMatchesHost(cmd(MULTI_HOST_BUCKET), ALL_HOSTS)).toBe(true);
    });

    it('matches only the selected host bucket otherwise', () => {
      expect(eventMatchesHost(cmd('h1'), 'h1')).toBe(true);
      expect(eventMatchesHost(cmd('h2'), 'h1')).toBe(false);
      // Multi-host activity only shows in the ALL view.
      expect(eventMatchesHost(cmd(MULTI_HOST_BUCKET), 'h1')).toBe(false);
    });
  });
});
