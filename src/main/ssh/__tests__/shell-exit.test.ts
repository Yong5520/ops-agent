import { describe, it, expect } from 'vitest';
import { markShellExited, exitReason, type ShellExitTracking } from '../shell-exit.js';

function freshSession(): ShellExitTracking {
  return { closed: false, shellExited: false };
}

describe('shell-exit tracking (v24: distinguish user exit from network drop)', () => {
  it('markShellExited marks the session closed with shellExited=true', () => {
    const session = freshSession();
    markShellExited(session);
    expect(session.closed).toBe(true);
    expect(session.shellExited).toBe(true);
  });

  it('exitReason reports "shell-exited" when the shell exited normally', () => {
    const session = freshSession();
    markShellExited(session);
    expect(exitReason(session)).toBe('shell-exited');
  });

  it('exitReason reports "Stream closed" for a kill/unexpected close (no exit event)', () => {
    const session = freshSession();
    session.closed = true; // e.g. terminal:kill
    expect(exitReason(session)).toBe('Stream closed');
    expect(exitReason(freshSession())).toBe('Stream closed');
  });
});
