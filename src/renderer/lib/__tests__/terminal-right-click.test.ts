import { describe, it, expect } from 'vitest';
import { decideRightClickAction } from '../terminal-right-click.js';

describe('decideRightClickAction', () => {
  it('copies (and clears the selection) on plain right-click with a selection', () => {
    // Two-step MobaXterm/jumpserver flow: right-click with a selection only
    // COPIES it (the view also clears the selection), so the second
    // right-click - now with no selection - pastes from the clipboard.
    expect(decideRightClickAction(true, false)).toBe('copy');
  });

  it('pastes on plain right-click with no selection', () => {
    expect(decideRightClickAction(false, false)).toBe('paste');
  });

  it('always opens the menu when Shift is held, regardless of selection', () => {
    expect(decideRightClickAction(true, true)).toBe('menu');
    expect(decideRightClickAction(false, true)).toBe('menu');
  });
});
