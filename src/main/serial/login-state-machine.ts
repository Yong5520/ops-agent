// Pure auto-login state machine for serial consoles.
//
// The driver is fed the accumulated console output (feed()) and returns the
// actions the connection layer should perform (send a line). It never touches
// a port itself, so login behavior is fully unit-testable.
//
// State machine:
//   idle --login prompt--> sentUsername --password prompt--> sentPassword
//   any --CLI prompt--> ready (device was already logged in / boot finished)
//   sentUsername/sentPassword --login prompt again--> failed (bad credentials
//   or a login loop - never resend credentials, that risks account lockout)

import {
  detectLoginPrompt,
  detectPasswordPrompt,
  detectBootPrompt,
  endsWithCliPrompt,
} from './serial-prompts.js';

// Failure banners a console prints before re-displaying the login prompt after
// bad credentials ("Login failed", "Password incorrect", "错误" ...).
const FAILURE_MARKER_RE = /fail|incorrect|denied|invalid|wrong|error|错误|失败|无效/i;

export interface LoginDriverOptions {
  username: string;
  password: string;
}

export type LoginAction = { type: 'send'; data: string };

export type LoginState = 'idle' | 'sentUsername' | 'sentPassword' | 'ready' | 'failed';

export interface LoginDriver {
  /** Feed the accumulated output buffer (or just a new chunk - only the tail
   * is kept). Returns actions to perform now. */
  feed(chunk: string): LoginAction[];
  getState(): LoginState;
}

export function createLoginDriver(opts: LoginDriverOptions): LoginDriver {
  let buffer = '';
  let state: LoginState = 'idle';

  const trim = (): void => {
    if (buffer.length > 512) buffer = buffer.slice(-512);
  };

  return {
    feed(chunk: string): LoginAction[] {
      if (state === 'ready' || state === 'failed') return [];
      buffer += chunk;
      trim();

      // CLI prompt visible -> we're in (either never asked to log in, or the
      // credentials we sent were accepted).
      if (endsWithCliPrompt(buffer)) {
        state = 'ready';
        return [];
      }

      // Credentials already sent but the device asks to log in again. Two very
      // different causes: (a) a failure banner followed by a fresh prompt
      // (wrong credentials), or (b) the console echoing the prompt back after
      // our input. Only (a) is a failure - and we never resend credentials
      // either way (account lockout risk).
      if (state !== 'idle' && detectLoginPrompt(buffer)) {
        if (FAILURE_MARKER_RE.test(buffer)) {
          state = 'failed';
          return [];
        }
        // Echo: ignore and keep waiting for the password prompt / CLI prompt.
        buffer = '';
        return [];
      }

      switch (state) {
        case 'idle':
          if (detectPasswordPrompt(buffer)) {
            // Password-only console (e.g. boot ROM): answer directly.
            buffer = '';
            state = 'sentPassword';
            return [{ type: 'send', data: opts.password + '\r' }];
          }
          if (detectLoginPrompt(buffer)) {
            buffer = '';
            state = 'sentUsername';
            return [{ type: 'send', data: opts.username + '\r' }];
          }
          if (detectBootPrompt(buffer)) {
            buffer = '';
            return [{ type: 'send', data: '\r' }];
          }
          return [];
        case 'sentUsername':
          if (detectPasswordPrompt(buffer)) {
            buffer = '';
            state = 'sentPassword';
            return [{ type: 'send', data: opts.password + '\r' }];
          }
          return [];
        default:
          return [];
      }
    },
    getState(): LoginState {
      return state;
    },
  };
}
