/**
 * Shell-exit tracking for SSH terminal sessions (v24).
 *
 * When the user exits the remote shell themselves (types `exit`/`logout` or
 * presses Ctrl+D), ssh2 emits the channel's 'exit' event - carrying the remote
 * exit status - BEFORE 'close'. A network drop never produces that event.
 * Marking the session here lets the 'close' handler take the clean-exit path
 * (no reconnect loop) and report reason 'shell-exited', which the renderer
 * turns into an automatic tab close.
 */

/** Subset of TerminalSession these helpers operate on (structurally typed). */
export interface ShellExitTracking {
  closed: boolean;
  /** True once the channel's 'exit' event was received. */
  shellExited: boolean;
}

/** ssh2 'exit' event received: the remote shell exited normally. */
export function markShellExited(session: ShellExitTracking): void {
  session.closed = true;
  session.shellExited = true;
}

/** Exit reason string for the terminal:exit event, given the session state. */
export function exitReason(session: ShellExitTracking): string {
  return session.shellExited ? 'shell-exited' : 'Stream closed';
}
