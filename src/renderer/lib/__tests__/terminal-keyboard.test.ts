import { describe, it, expect } from 'vitest';
import { decideCtrlCAction } from '../terminal-keyboard.js';

describe('decideCtrlCAction', () => {
  it('copies when there is a selection', () => {
    // jumpserver-style: Ctrl+C with a selection copies instead of sending
    // SIGINT, so users can stop a running command and copy output without
    // accidentally interrupting twice.
    expect(decideCtrlCAction(true)).toBe('copy');
  });

  it('sends SIGINT when there is no selection', () => {
    expect(decideCtrlCAction(false)).toBe('sigint');
  });
});
