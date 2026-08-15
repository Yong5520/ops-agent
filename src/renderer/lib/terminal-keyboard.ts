// Keyboard clipboard helpers for the terminal.
//
// jumpserver-style Ctrl+C: when the terminal has a text selection, Ctrl+C
// copies the selection (so users can grab output without interrupting); when
// nothing is selected, Ctrl+C sends SIGINT (\x03) as usual. The decision is a
// pure function so it can be unit-tested without a DOM or xterm instance.

export type CtrlCAction = 'copy' | 'sigint';

/**
 * Decide what plain Ctrl+C (no Shift) should do.
 *
 * @param hasSelection  whether the terminal currently has a text selection
 */
export function decideCtrlCAction(hasSelection: boolean): CtrlCAction {
  return hasSelection ? 'copy' : 'sigint';
}
