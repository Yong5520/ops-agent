import { describe, it, expect, vi } from 'vitest';
import {
  sendToOwner,
  killSessionsForWindow,
  type OwnerWindowLike,
  type TerminalSessionLike,
} from '../terminal-routing.js';

// Fake owner window: tracks whether it's "destroyed" and records sent events.
interface FakeWindow extends OwnerWindowLike {
  __sent: Array<{ channel: string; args: unknown[] }>;
}

function makeWindow(opts: { destroyed?: boolean; wcDestroyed?: boolean } = {}): FakeWindow {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  return {
    isDestroyed: () => opts.destroyed ?? false,
    webContents: {
      isDestroyed: () => opts.wcDestroyed ?? false,
      send: (channel: string, ...args: unknown[]) => {
        sent.push({ channel, args });
      },
    },
    __sent: sent,
  };
}

function makeSession(
  win: OwnerWindowLike,
  over: Partial<TerminalSessionLike> = {},
): TerminalSessionLike {
  return {
    sessionId: 's1',
    hostId: 'h1',
    hostName: 'host1',
    type: 'ssh',
    ownerWindow: win,
    stream: { destroy: vi.fn() },
    pty: { kill: vi.fn() },
    closed: false,
    ...over,
  };
}

describe('sendToOwner (multi-window event routing)', () => {
  it('sends the event to the session owner window, not a hardcoded main window', () => {
    const win = makeWindow();
    sendToOwner(makeSession(win), 'terminal:data', 's1', 'hello');
    expect(win.__sent).toHaveLength(1);
    expect(win.__sent[0]).toEqual({ channel: 'terminal:data', args: ['s1', 'hello'] });
  });

  it('routes to each session its own owner (two windows never cross)', () => {
    const winA = makeWindow();
    const winB = makeWindow();
    sendToOwner(makeSession(winA, { sessionId: 'a' }), 'terminal:data', 'a', 'A');
    sendToOwner(makeSession(winB, { sessionId: 'b' }), 'terminal:data', 'b', 'B');
    expect(winA.__sent[0].args).toEqual(['a', 'A']);
    expect(winB.__sent[0].args).toEqual(['b', 'B']);
  });

  it('drops the event silently when the owner window is destroyed (no throw)', () => {
    const win = makeWindow({ destroyed: true });
    expect(() => sendToOwner(makeSession(win), 'terminal:data', 's1', 'x')).not.toThrow();
    expect(win.__sent).toHaveLength(0);
  });

  it('drops the event when the webContents is destroyed', () => {
    const win = makeWindow({ wcDestroyed: true });
    sendToOwner(makeSession(win), 'terminal:data', 's1', 'x');
    expect(win.__sent).toHaveLength(0);
  });

  it('drops the event when ownerWindow is null', () => {
    const session = makeSession(makeWindow(), { ownerWindow: null });
    expect(() => sendToOwner(session, 'terminal:data', 's1', 'x')).not.toThrow();
  });
});

describe('killSessionsForWindow (window-close leak prevention)', () => {
  it('kills only sessions owned by the closing window and leaves others untouched', () => {
    const winA = makeWindow();
    const winB = makeWindow();
    const a1 = makeSession(winA, { sessionId: 'a1', hostId: 'h1' });
    const a2 = makeSession(winA, { sessionId: 'a2', hostId: 'h2' });
    const b1 = makeSession(winB, { sessionId: 'b1', hostId: 'h3' });
    // Capture spies before the call - killSessionsForWindow nulls stream/pty.
    const a1Destroy = a1.stream!.destroy as ReturnType<typeof vi.fn>;
    const a2Destroy = a2.stream!.destroy as ReturnType<typeof vi.fn>;
    const b1Destroy = b1.stream!.destroy as ReturnType<typeof vi.fn>;
    const map = new Map<string, TerminalSessionLike>([
      ['a1', a1],
      ['a2', a2],
      ['b1', b1],
    ]);
    const onSshKilled = vi.fn();

    killSessionsForWindow(winA, map, onSshKilled);

    expect(map.has('a1')).toBe(false);
    expect(map.has('a2')).toBe(false);
    // b1 belongs to winB and must survive.
    expect(map.has('b1')).toBe(true);
    expect(a1.closed).toBe(true);
    expect(a2.closed).toBe(true);
    expect(b1.closed).toBe(false);
    expect(a1Destroy).toHaveBeenCalled();
    expect(a2Destroy).toHaveBeenCalled();
    expect(b1Destroy).not.toHaveBeenCalled();
    // SSH sessions report their host for active-terminal unmarking.
    expect(onSshKilled).toHaveBeenCalledWith('h1');
    expect(onSshKilled).toHaveBeenCalledWith('h2');
    expect(onSshKilled).not.toHaveBeenCalledWith('h3');
  });

  it('does not call onSshKilled for local (non-ssh) sessions', () => {
    const win = makeWindow();
    const local = makeSession(win, { sessionId: 'loc', type: 'local' });
    const localKill = local.pty!.kill as ReturnType<typeof vi.fn>;
    const map = new Map<string, TerminalSessionLike>([['loc', local]]);
    const onSshKilled = vi.fn();
    killSessionsForWindow(win, map, onSshKilled);
    expect(onSshKilled).not.toHaveBeenCalled();
    expect(localKill).toHaveBeenCalled();
    expect(map.has('loc')).toBe(false);
  });

  it('survives a session whose stream/pty destroy throws (defensive try/catch)', () => {
    const win = makeWindow();
    const session = makeSession(win, {
      stream: {
        destroy: () => {
          throw new Error('already gone');
        },
      },
      pty: {
        kill: () => {
          throw new Error('dead');
        },
      },
    });
    const map = new Map<string, TerminalSessionLike>([['s', session]]);
    expect(() => killSessionsForWindow(win, map, vi.fn())).not.toThrow();
    expect(map.has('s')).toBe(false);
    expect(session.closed).toBe(true);
  });

  it('is a no-op when the window owns no sessions', () => {
    const win = makeWindow();
    const map = new Map<string, TerminalSessionLike>([['s', makeSession(makeWindow())]]);
    killSessionsForWindow(win, map, vi.fn());
    expect(map.size).toBe(1);
  });
});
