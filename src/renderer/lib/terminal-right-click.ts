// Right-click behavior helpers for the terminal.
//
// MobaXterm/jumpserver-style smart right-click: in "quick" mode a plain
// right-click with a selection copies it to the clipboard AND inserts it at
// the cursor (so a selected snippet can be dropped straight onto the command
// line), while a plain right-click with no selection pastes from the
// clipboard - no menu, no focus loss. Shift+right-click always opens the full
// menu (search / clear / export / upload / download) so power-user actions
// stay reachable. In "menu" mode a plain right-click opens the menu directly
// (legacy behavior).

export type RightClickMode = 'quick' | 'menu';
export type RightClickAction = 'copyAndInsert' | 'paste' | 'menu';

/**
 * Decide what a right-click should do.
 *
 * @param hasSelection  whether the terminal currently has a text selection
 * @param mode          the user's preferred right-click mode
 * @param shiftKey      whether Shift was held during the right-click
 */
export function decideRightClickAction(
  hasSelection: boolean,
  mode: RightClickMode,
  shiftKey: boolean,
): RightClickAction {
  // Shift+right-click always opens the menu so power-user actions stay reachable.
  if (shiftKey || mode === 'menu') return 'menu';
  // Quick mode: copy+insert when there is a selection, paste otherwise.
  return hasSelection ? 'copyAndInsert' : 'paste';
}
