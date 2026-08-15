// Unit tests for the pure serial auto-login state machine. The driver is fed
// accumulated console output and answers with the actions to send.
import { describe, it, expect } from 'vitest';
import { createLoginDriver } from '../login-state-machine.js';

describe('createLoginDriver', () => {
  it('sends the username when a login prompt appears', () => {
    const d = createLoginDriver({ username: 'admin', password: 'secret' });
    const actions = d.feed('Login: ');
    expect(actions).toEqual([{ type: 'send', data: 'admin\r' }]);
    expect(d.getState()).toBe('sentUsername');
  });

  it('sends the password when a password prompt appears (after username)', () => {
    const d = createLoginDriver({ username: 'admin', password: 'secret' });
    d.feed('Username: ');
    const actions = d.feed('Password: ');
    expect(actions).toEqual([{ type: 'send', data: 'secret\r' }]);
    expect(d.getState()).toBe('sentPassword');
  });

  it('answers a password-only prompt directly (no username stage)', () => {
    // Some consoles (e.g. boot ROMs, enable mode) ask only for a password.
    const d = createLoginDriver({ username: 'admin', password: 'secret' });
    const actions = d.feed('Password: ');
    expect(actions).toEqual([{ type: 'send', data: 'secret\r' }]);
    expect(d.getState()).toBe('sentPassword');
  });

  it('becomes ready when a CLI prompt appears (already logged in)', () => {
    const d = createLoginDriver({ username: 'admin', password: 'secret' });
    const actions = d.feed('Welcome!\r\n<Switch>');
    expect(d.getState()).toBe('ready');
    expect(actions).toEqual([]);
  });

  it('becomes ready after full login sequence', () => {
    const d = createLoginDriver({ username: 'admin', password: 'secret' });
    d.feed('Login: ');
    d.feed('Password: ');
    d.feed('\r\n<Switch>');
    expect(d.getState()).toBe('ready');
  });

  it('sends only a newline for boot continuation prompts', () => {
    const d = createLoginDriver({ username: 'admin', password: 'secret' });
    const actions = d.feed('Press any key to get started');
    expect(actions).toEqual([{ type: 'send', data: '\r' }]);
    expect(d.getState()).toBe('idle'); // still waiting for login/prompt
  });

  it('is idempotent: does not resend the username on repeated chunks', () => {
    const d = createLoginDriver({ username: 'admin', password: 'secret' });
    d.feed('Login: ');
    const actions = d.feed('Login: '); // echoed prompt again
    expect(actions).toEqual([]);
    expect(d.getState()).toBe('sentUsername');
  });

  it('ignores prompts split across feeds (buffer accumulation)', () => {
    const d = createLoginDriver({ username: 'admin', password: 'secret' });
    expect(d.feed('Log')).toEqual([]);
    const actions = d.feed('in: ');
    expect(actions).toEqual([{ type: 'send', data: 'admin\r' }]);
  });

  it('reports failed when a re-login prompt appears after credentials', () => {
    // Wrong password: device re-displays the login prompt after we already sent
    // both credentials -> surface as failed instead of looping forever.
    const d = createLoginDriver({ username: 'admin', password: 'wrong' });
    d.feed('Login: ');
    d.feed('Password: ');
    const actions = d.feed('Login failed\r\nLogin: ');
    expect(d.getState()).toBe('failed');
    expect(actions).toEqual([]);
  });
});
