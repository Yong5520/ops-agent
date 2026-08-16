/**
 * Renderer-side policy for terminal:exit events (v24).
 *
 * Page-level exit listeners (TerminalPage / TerminalWindowPage) must keep
 * working even when the TerminalView component is unmounted - e.g. while the
 * "reconnecting" overlay replaces it - so the decision is a pure function
 * shared by every listener instead of inline JSX logic.
 */

export type ExitAction = 'close-tab' | 'reconnecting' | 'disconnected';

/**
 * Map a terminal:exit reason to what the page should do:
 * - 'shell-exited'  -> the user exited the shell (exit/logout/Ctrl+D);
 *   close the tab (or standalone window) automatically.
 * - 'reconnecting'  -> the main process started its reconnect attempts.
 * - anything else   -> the connection is gone (reconnect-failed, Stream
 *   closed, serial port lost) - show the disconnected state.
 */
export function resolveExitAction(reason: string): ExitAction {
  if (reason === 'shell-exited') return 'close-tab';
  if (reason === 'reconnecting') return 'reconnecting';
  return 'disconnected';
}
