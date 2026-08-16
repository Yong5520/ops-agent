import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetActivityMirror,
  activityMirrorRecord,
  activityMirrorHistory,
  activityMirrorSubscribe,
} from '../activity-mirror.js';
import type { AgentMirrorEvent } from '../../../shared/activity-mirror-types.js';

describe('activity-mirror (v24: raw AI-channel mirror, shared by all windows)', () => {
  beforeEach(() => {
    resetActivityMirror();
  });

  it('records command/chunk/final events with a monotonic seq', () => {
    activityMirrorRecord({
      kind: 'command',
      sessionId: 's1',
      hostId: 'h1',
      hostName: 'web1',
      toolName: 'exec',
      command: 'uptime',
      commandType: 'READ',
    });
    activityMirrorRecord({
      kind: 'chunk',
      sessionId: 's1',
      hostId: 'h1',
      stream: 'stdout',
      data: 'raw output\x1b[0m',
    });
    activityMirrorRecord({
      kind: 'final',
      sessionId: 's1',
      hostId: 'h1',
      success: true,
      exitCode: 0,
      durationMs: 12,
    });

    const all = activityMirrorHistory();
    expect(all.map((e) => e.kind)).toEqual(['command', 'chunk', 'final']);
    expect((all[0] as Extract<AgentMirrorEvent, { kind: 'command' }>).command).toBe('uptime');
    expect((all[1] as Extract<AgentMirrorEvent, { kind: 'chunk' }>).data).toBe('raw output\x1b[0m');
    // seq is monotonic across all events
    expect(all[1].seq).toBeGreaterThan(all[0].seq);
    expect(all[2].seq).toBeGreaterThan(all[1].seq);
  });

  it('returns an immutable copy (callers cannot mutate the ring)', () => {
    activityMirrorRecord({
      kind: 'command',
      sessionId: 's1',
      hostId: 'h1',
      hostName: 'web1',
      toolName: 'exec',
      command: 'ls',
      commandType: 'READ',
    });
    const history = activityMirrorHistory();
    history.length = 0;
    expect(activityMirrorHistory().length).toBe(1);
  });

  it('scopes history to a session and a host bucket', () => {
    activityMirrorRecord({
      kind: 'command',
      sessionId: 's1',
      hostId: 'h1',
      hostName: 'web1',
      toolName: 'exec',
      command: 'a',
      commandType: 'READ',
    });
    activityMirrorRecord({
      kind: 'command',
      sessionId: 's2',
      hostId: 'h1',
      hostName: 'web1',
      toolName: 'exec',
      command: 'b',
      commandType: 'READ',
    });
    activityMirrorRecord({
      kind: 'command',
      sessionId: 's1',
      hostId: '__multi__',
      hostName: '3 hosts',
      toolName: 'exec_multi',
      command: 'c',
      commandType: 'READ',
    });

    expect(
      activityMirrorHistory('s1', 'h1').map((e) => (e.kind === 'command' ? e.command : undefined)),
    ).toEqual(['a']);
    expect(
      activityMirrorHistory('s2', 'h1').map((e) => (e.kind === 'command' ? e.command : undefined)),
    ).toEqual(['b']);
    // ALL_HOSTS bucket ('__all__') sees both real hosts and the multi bucket
    expect(
      activityMirrorHistory('s1', '__all__').map((e) =>
        e.kind === 'command' ? e.command : undefined,
      ),
    ).toEqual(['a', 'c']);
  });

  it('forwards events to registered listeners (all windows)', () => {
    const seen: AgentMirrorEvent[] = [];
    const off = activityMirrorSubscribe((e) => seen.push(e));
    activityMirrorRecord({
      kind: 'command',
      sessionId: 's1',
      hostId: 'h1',
      hostName: 'web1',
      toolName: 'exec',
      command: 'x',
      commandType: 'READ',
    });
    off();
    activityMirrorRecord({
      kind: 'command',
      sessionId: 's1',
      hostId: 'h1',
      hostName: 'web1',
      toolName: 'exec',
      command: 'y',
      commandType: 'READ',
    });
    expect(seen.map((e) => (e.kind === 'command' ? e.command : undefined))).toEqual(['x']);
  });

  it('a listener that throws does not break recording', () => {
    const off = activityMirrorSubscribe(() => {
      throw new Error('listener bug');
    });
    expect(() =>
      activityMirrorRecord({
        kind: 'command',
        sessionId: 's1',
        hostId: 'h1',
        hostName: 'web1',
        toolName: 'exec',
        command: 'z',
        commandType: 'READ',
      }),
    ).not.toThrow();
    expect(activityMirrorHistory().length).toBe(1);
    off();
  });

  it('caps the ring buffer (oldest events drop)', () => {
    const big = 'x'.repeat(600);
    for (let i = 0; i < 250; i++) {
      activityMirrorRecord({
        kind: 'chunk',
        sessionId: 's1',
        hostId: 'h1',
        stream: 'stdout',
        data: big,
      });
    }
    const history = activityMirrorHistory();
    expect(history.length).toBeLessThanOrEqual(200);
    // Rough memory bound: total data stays bounded
    const total = history.reduce((n, e) => n + (e.kind === 'chunk' ? e.data.length : 0), 0);
    expect(total).toBeLessThanOrEqual(200 * 600);
  });
});
