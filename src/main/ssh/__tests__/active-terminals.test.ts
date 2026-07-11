import { describe, it, expect, beforeEach } from 'vitest';
import {
  markTerminalActive,
  unmarkTerminalActive,
  hasActiveTerminal,
  getActiveTerminalHosts,
} from '../active-terminals.js';

describe('active-terminals tracker', () => {
  beforeEach(() => {
    // Clean up any state between tests
    for (const h of getActiveTerminalHosts()) {
      unmarkTerminalActive(h);
    }
  });

  it('marks a host as active', () => {
    markTerminalActive('host-1');
    expect(hasActiveTerminal('host-1')).toBe(true);
  });

  it('returns false for unmarked host', () => {
    expect(hasActiveTerminal('host-unknown')).toBe(false);
  });

  it('unmarks a host', () => {
    markTerminalActive('host-2');
    unmarkTerminalActive('host-2');
    expect(hasActiveTerminal('host-2')).toBe(false);
  });

  it('supports multiple hosts simultaneously', () => {
    markTerminalActive('host-a');
    markTerminalActive('host-b');
    markTerminalActive('host-c');
    expect(hasActiveTerminal('host-a')).toBe(true);
    expect(hasActiveTerminal('host-b')).toBe(true);
    expect(hasActiveTerminal('host-c')).toBe(true);
    expect(getActiveTerminalHosts().size).toBe(3);
  });

  it('unmarking one host leaves others intact', () => {
    markTerminalActive('host-a');
    markTerminalActive('host-b');
    unmarkTerminalActive('host-a');
    expect(hasActiveTerminal('host-a')).toBe(false);
    expect(hasActiveTerminal('host-b')).toBe(true);
  });

  it('double-marking does not duplicate', () => {
    markTerminalActive('host-x');
    markTerminalActive('host-x');
    expect(getActiveTerminalHosts().size).toBe(1);
  });

  it('unmarking a non-active host is a no-op', () => {
    unmarkTerminalActive('never-active');
    expect(getActiveTerminalHosts().size).toBe(0);
  });
});
