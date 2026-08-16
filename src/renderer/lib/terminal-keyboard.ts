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

/** Minimal keyboard-event shape used by the paste predicate. */
export interface KeyLike {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  key: string;
}

/**
 * Whether this event is a plain Ctrl+V (no Shift/Alt/Meta).
 *
 * xterm maps Ctrl+letter to C0 control codes - Ctrl+V becomes \x16 (SYN) -
 * and cancels the browser's default action, so no paste event ever fires and
 * plain Ctrl+V silently does nothing. The caller must intercept this combo
 * itself: preventDefault() + clipboard read + term.paste().
 */
export function isPlainCtrlV(e: KeyLike): boolean {
  return e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'v' || e.key === 'V');
}

/** Keyboard-event shape including the fields needed for once-per-press gating. */
export interface KeyEventLike extends KeyLike {
  /** DOM event type: 'keydown' | 'keyup' | 'keypress'. */
  type: string;
  /** Whether this keydown is a browser auto-repeat while the key is held. */
  repeat: boolean;
}

/**
 * Whether this event is the initial keydown of a key press - the only moment
 * a discrete action (paste / copy / open search / toggle) should fire.
 *
 * xterm's attachCustomKeyEventHandler is invoked for keydown, keyup AND
 * keypress (verified against xterm 6.0's _keyDown/_keyUp/_keyPress), and the
 * browser auto-repeats keydown while a key is held. Without this gate one
 * Ctrl+V press pastes again on keyup (ctrlKey is still true during V's keyup,
 * so isPlainCtrlV matches again) and again on every auto-repeat - producing
 * multiple pastes from a single press.
 *
 * Note: the SIGINT path (plain Ctrl+C with no selection) must NOT use this
 * gate - holding Ctrl+C should keep sending \x03 as usual.
 */
export function isInitialKeyDown(e: KeyEventLike): boolean {
  return e.type === 'keydown' && !e.repeat;
}

/** What TerminalView's xterm key handler should do with a keyboard event. */
export type TerminalKeyAction =
  /** Open the search bar (Ctrl+F). */
  | 'search'
  /** Toggle the AI bar (Ctrl+I). */
  | 'toggle-ai'
  /** Copy the terminal selection (Ctrl+Shift+C / plain Ctrl+C with selection). */
  | 'copy'
  /** Paste from the clipboard (Ctrl+Shift+V / plain Ctrl+V). */
  | 'paste'
  /** Let xterm send SIGINT \x03 (plain Ctrl+C without a selection) - NOT gated. */
  | 'sigint'
  /**
   * Recognized combo but not an initial keydown (keyup / keypress /
   * auto-repeat): caller must still preventDefault() + return false to keep
   * suppressing xterm's control codes, but must NOT re-run the action.
   */
  | 'xterm-suppress'
  /** Not our combo: return true so xterm processes the event normally. */
  | 'xterm-default';

/**
 * Pure decision extracted from TerminalView's attachCustomKeyEventHandler, so
 * the gated-vs-ungated contract is unit-testable: every discrete action
 * ('search' / 'toggle-ai' / 'copy' / 'paste') fires only on the initial
 * keydown of a press, while 'sigint' deliberately stays ungated so a held
 * Ctrl+C keeps sending \x03 on every auto-repeat.
 *
 * Branch order mirrors the original handler exactly (e.g. Ctrl+F matches
 * before the Ctrl+Shift variants) - do not reorder without re-checking
 * TerminalView's dispatch.
 *
 * @param e              the keyboard event (has type + repeat)
 * @param hasSelection   whether the terminal currently has a text selection
 */
export function decideTerminalKeyAction(e: KeyEventLike, hasSelection: boolean): TerminalKeyAction {
  const initial = isInitialKeyDown(e);
  if (e.ctrlKey && e.key === 'f') return initial ? 'search' : 'xterm-suppress';
  if (e.ctrlKey && e.key === 'i') return initial ? 'toggle-ai' : 'xterm-suppress';
  if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
    return initial ? 'copy' : 'xterm-suppress';
  }
  if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
    return initial ? 'paste' : 'xterm-suppress';
  }
  if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
    return decideCtrlCAction(hasSelection) === 'copy' && initial ? 'copy' : 'sigint';
  }
  if (isPlainCtrlV(e)) return initial ? 'paste' : 'xterm-suppress';
  return 'xterm-default';
}
