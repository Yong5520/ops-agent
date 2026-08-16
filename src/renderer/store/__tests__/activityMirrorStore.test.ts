import { describe, it, expect, beforeEach } from 'vitest';
import {
  useActivityMirrorStore,
  eventMatchesView,
  ALL_HOSTS,
  MULTI_HOST_BUCKET,
} from '../activityMirrorStore.js';
import type { AgentMirrorEvent } from '../../../shared/activity-mirror-types.js';

function cmd(seq: number, hostId: string, sessionId = 's1'): AgentMirrorEvent {
  return {
    kind: 'command',
    seq,
    sessionId,
    hostId,
    hostName: hostId,
    toolName: 'exec',
    command: `cmd-${seq}`,
    commandType: 'READ',
  };
}

describe('activityMirrorStore (v24 renderer mirror cache)', () => {
  beforeEach(() => {
    useActivityMirrorStore.setState({ sessionId: '', selectedHostId: ALL_HOSTS, events: [] });
  });

  it('appends live events in order', () => {
    useActivityMirrorStore.getState().append(cmd(1, 'h1'));
    useActivityMirrorStore.getState().append(cmd(2, 'h1'));
    expect(useActivityMirrorStore.getState().events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('drops a stale/duplicate event (seq already seen)', () => {
    useActivityMirrorStore.getState().append(cmd(5, 'h1'));
    useActivityMirrorStore.getState().append(cmd(3, 'h1')); // stale
    expect(useActivityMirrorStore.getState().events.map((e) => e.seq)).toEqual([5]);
  });

  it('setEvents replaces the buffer (replay on mount)', () => {
    useActivityMirrorStore.getState().append(cmd(1, 'h1'));
    useActivityMirrorStore.getState().setEvents([cmd(10, 'h1'), cmd(11, 'h1')]);
    expect(useActivityMirrorStore.getState().events.map((e) => e.seq)).toEqual([10, 11]);
  });

  it('selectHost / setSession update the view filter', () => {
    useActivityMirrorStore.getState().selectHost('h2');
    useActivityMirrorStore.getState().setSession('s9');
    expect(useActivityMirrorStore.getState().selectedHostId).toBe('h2');
    expect(useActivityMirrorStore.getState().sessionId).toBe('s9');
  });

  it('clear empties the buffer', () => {
    useActivityMirrorStore.getState().append(cmd(1, 'h1'));
    useActivityMirrorStore.getState().clear();
    expect(useActivityMirrorStore.getState().events).toEqual([]);
  });
});

describe('eventMatchesView', () => {
  it('ALL_HOSTS matches any host bucket including the multi aggregate', () => {
    expect(eventMatchesView(cmd(1, 'h1'), '', ALL_HOSTS)).toBe(true);
    expect(eventMatchesView(cmd(1, MULTI_HOST_BUCKET), '', ALL_HOSTS)).toBe(true);
  });

  it('a specific host matches only its own bucket', () => {
    expect(eventMatchesView(cmd(1, 'h1'), '', 'h1')).toBe(true);
    expect(eventMatchesView(cmd(1, 'h2'), '', 'h1')).toBe(false);
  });

  it('a set session filters out other sessions', () => {
    expect(eventMatchesView(cmd(1, 'h1', 's1'), 's1', ALL_HOSTS)).toBe(true);
    expect(eventMatchesView(cmd(1, 'h1', 's2'), 's1', ALL_HOSTS)).toBe(false);
  });

  it('empty session matches every session (global view)', () => {
    expect(eventMatchesView(cmd(1, 'h1', 's7'), '', ALL_HOSTS)).toBe(true);
  });
});
