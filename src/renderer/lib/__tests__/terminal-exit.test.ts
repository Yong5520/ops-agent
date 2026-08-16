import { describe, it, expect } from 'vitest';
import { resolveExitAction } from '../terminal-exit.js';

describe('resolveExitAction (v24: renderer exit-event policy)', () => {
  it('auto-closes the tab when the user exited the shell (exit / logout / Ctrl+D)', () => {
    expect(resolveExitAction('shell-exited')).toBe('close-tab');
  });

  it('maps a reconnect announcement to the reconnecting status', () => {
    expect(resolveExitAction('reconnecting')).toBe('reconnecting');
  });

  it('maps everything else (reconnect-failed, Stream closed, serial messages) to disconnected', () => {
    expect(resolveExitAction('reconnect-failed')).toBe('disconnected');
    expect(resolveExitAction('Stream closed')).toBe('disconnected');
    expect(resolveExitAction('串口已断开（设备拔出或端口被占用）')).toBe('disconnected');
  });
});
