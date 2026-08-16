// Right-click behavior helpers for the terminal.
//
// MobaXterm/jumpserver-style smart right-click (fixed behavior, not
// configurable): a plain right-click with a selection copies it to the
// clipboard (the view also clears the selection), while a plain right-click
// with no selection pastes from the clipboard - no menu, no focus loss. This
// gives the two-step flow: right-click copies + deselects, right-click again
// pastes. Shift+right-click always opens the full menu (search / clear /
// export / upload / download) so power-user actions stay reachable.

export type RightClickAction = 'copy' | 'paste' | 'menu';

/**
 * Decide what a right-click should do.
 *
 * @param hasSelection  whether the terminal currently has a text selection
 * @param shiftKey      whether Shift was held during the right-click
 */
export function decideRightClickAction(hasSelection: boolean, shiftKey: boolean): RightClickAction {
  // Shift+right-click always opens the menu so power-user actions stay reachable.
  if (shiftKey) return 'menu';
  // Plain right-click: copy when there is a selection, paste otherwise.
  return hasSelection ? 'copy' : 'paste';
}
