import { describe, it, expect } from 'vitest';
import {
  decideCtrlCAction,
  isPlainCtrlV,
  isInitialKeyDown,
  decideTerminalKeyAction,
  type KeyEventLike,
} from '../terminal-keyboard.js';

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

describe('isPlainCtrlV (v24: xterm swallows plain Ctrl+V as \\x16)', () => {
  // xterm maps Ctrl+letter to C0 control codes (\x16 for ^V) and cancels the
  // browser's default paste action, so plain Ctrl+V never pastes unless we
  // intercept it explicitly.
  it('matches plain Ctrl+V (either case)', () => {
    expect(
      isPlainCtrlV({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 'v' }),
    ).toBe(true);
    expect(
      isPlainCtrlV({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 'V' }),
    ).toBe(true);
  });

  it('does not match Ctrl+Shift+V (that path pastes already)', () => {
    expect(
      isPlainCtrlV({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'v' }),
    ).toBe(false);
  });

  it('does not match other modifiers or keys', () => {
    expect(
      isPlainCtrlV({ ctrlKey: true, shiftKey: false, altKey: true, metaKey: false, key: 'v' }),
    ).toBe(false);
    expect(
      isPlainCtrlV({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: true, key: 'v' }),
    ).toBe(false);
    expect(
      isPlainCtrlV({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 'c' }),
    ).toBe(false);
  });
});

describe('isInitialKeyDown (xterm re-fires the handler on keyup/keypress)', () => {
  // xterm's attachCustomKeyEventHandler is invoked for keydown, keyup AND
  // keypress (verified against xterm 6.0 source), and the browser auto-repeats
  // keydown while a key is held. Discrete actions (paste/copy/search/toggle)
  // must fire only on the initial keydown, otherwise one Ctrl+V press pastes
  // again on keyup (ctrlKey is still true during V's keyup) and again on every
  // auto-repeat - "pressing Ctrl+V pastes multiple times".
  const base = {
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    key: 'v',
  };

  it('is true for the first keydown of a press', () => {
    expect(isInitialKeyDown({ ...base, type: 'keydown', repeat: false })).toBe(true);
  });

  it('is false on keyup so a held Ctrl+V does not paste again on release', () => {
    expect(isInitialKeyDown({ ...base, type: 'keyup', repeat: false })).toBe(false);
  });

  it('is false on keypress events', () => {
    expect(isInitialKeyDown({ ...base, type: 'keypress', repeat: false })).toBe(false);
  });

  it('is false on auto-repeat while the key is held down', () => {
    expect(isInitialKeyDown({ ...base, type: 'keydown', repeat: true })).toBe(false);
  });
});

describe('decideTerminalKeyAction (TerminalView key handler contract)', () => {
  // Locks in the load-bearing wiring of TerminalView's
  // attachCustomKeyEventHandler: every discrete action fires only on the
  // initial keydown (keyup/keypress/auto-repeat fall through to
  // 'xterm-suppress'), while SIGINT must NOT be gated - held Ctrl+C keeps
  // sending \x03 on every auto-repeat.
  const ev = (overrides: Partial<KeyEventLike>): KeyEventLike => ({
    type: 'keydown',
    repeat: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    key: '',
    ...overrides,
  });

  it('routes Ctrl+F / Ctrl+I to their actions on the initial keydown', () => {
    expect(decideTerminalKeyAction(ev({ ctrlKey: true, key: 'f' }), false)).toBe('search');
    expect(decideTerminalKeyAction(ev({ ctrlKey: true, key: 'i' }), false)).toBe('toggle-ai');
  });

  it('routes Ctrl+Shift+C and Ctrl+C-with-selection to copy', () => {
    expect(decideTerminalKeyAction(ev({ ctrlKey: true, shiftKey: true, key: 'C' }), true)).toBe(
      'copy',
    );
    expect(decideTerminalKeyAction(ev({ ctrlKey: true, key: 'c' }), true)).toBe('copy');
  });

  it('routes Ctrl+Shift+V and plain Ctrl+V to paste', () => {
    expect(decideTerminalKeyAction(ev({ ctrlKey: true, shiftKey: true, key: 'V' }), false)).toBe(
      'paste',
    );
    expect(decideTerminalKeyAction(ev({ ctrlKey: true, key: 'v' }), false)).toBe('paste');
  });

  it('routes plain Ctrl+C without a selection to sigint (NOT gated by initial keydown)', () => {
    expect(decideTerminalKeyAction(ev({ ctrlKey: true, key: 'c' }), false)).toBe('sigint');
    // Contract: held Ctrl+C keeps sending SIGINT on every auto-repeat.
    expect(decideTerminalKeyAction(ev({ ctrlKey: true, key: 'c', repeat: true }), false)).toBe(
      'sigint',
    );
  });

  it('suppresses discrete actions on keyup so Ctrl+V does not paste twice', () => {
    expect(decideTerminalKeyAction(ev({ type: 'keyup', ctrlKey: true, key: 'v' }), false)).toBe(
      'xterm-suppress',
    );
    expect(decideTerminalKeyAction(ev({ type: 'keyup', ctrlKey: true, key: 'f' }), false)).toBe(
      'xterm-suppress',
    );
  });

  it('suppresses discrete actions on keypress events', () => {
    expect(decideTerminalKeyAction(ev({ type: 'keypress', ctrlKey: true, key: 'v' }), false)).toBe(
      'xterm-suppress',
    );
  });

  it('suppresses discrete actions on auto-repeat so held Ctrl+V pastes exactly once', () => {
    expect(decideTerminalKeyAction(ev({ ctrlKey: true, key: 'v', repeat: true }), false)).toBe(
      'xterm-suppress',
    );
    expect(
      decideTerminalKeyAction(ev({ ctrlKey: true, shiftKey: true, key: 'V', repeat: true }), false),
    ).toBe('xterm-suppress');
    // Copy is idempotent but also fires once.
    expect(
      decideTerminalKeyAction(ev({ ctrlKey: true, shiftKey: true, key: 'C', repeat: true }), true),
    ).toBe('xterm-suppress');
  });

  it('leaves everything else to xterm', () => {
    expect(decideTerminalKeyAction(ev({ key: 'a' }), false)).toBe('xterm-default');
    expect(decideTerminalKeyAction(ev({ ctrlKey: true, key: 'l' }), false)).toBe('xterm-default');
  });
});
