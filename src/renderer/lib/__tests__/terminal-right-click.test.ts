import { describe, it, expect } from 'vitest';
import { decideRightClickAction } from '../terminal-right-click.js';

describe('decideRightClickAction', () => {
  it('copies in quick mode when there is a selection', () => {
    expect(decideRightClickAction(true, 'quick', false)).toBe('copy');
  });

  it('pastes in quick mode when there is no selection', () => {
    expect(decideRightClickAction(false, 'quick', false)).toBe('paste');
  });

  it('always opens the menu in menu mode regardless of selection', () => {
    expect(decideRightClickAction(true, 'menu', false)).toBe('menu');
    expect(decideRightClickAction(false, 'menu', false)).toBe('menu');
  });

  it('always opens the menu when Shift is held in quick mode', () => {
    expect(decideRightClickAction(true, 'quick', true)).toBe('menu');
    expect(decideRightClickAction(false, 'quick', true)).toBe('menu');
  });

  it('always opens the menu when Shift is held in menu mode', () => {
    expect(decideRightClickAction(false, 'menu', true)).toBe('menu');
  });
});
