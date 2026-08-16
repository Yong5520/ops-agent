import { describe, it, expect } from 'vitest';
import { isSshConnectionError } from '../connection-errors.js';

describe('isSshConnectionError (shared, extracted from tools.ts v24)', () => {
  it('matches OpsAgentError codes for broken connections', () => {
    expect(isSshConnectionError({ code: 'SSH_TIMEOUT' } as unknown as Error)).toBe(true);
    expect(isSshConnectionError({ code: 'SSH_NOT_CONNECTED' } as unknown as Error)).toBe(true);
  });

  it('matches the SFTP channel-open failure the user hit (MaxSessions)', () => {
    expect(
      isSshConnectionError(new Error('SFTP error: (SSH) Channel open failure: open failed')),
    ).toBe(true);
    expect(isSshConnectionError(new Error('MaxSessions exceeded'))).toBe(true);
  });

  it('matches other zombie-connection signatures', () => {
    expect(isSshConnectionError(new Error('ECONNRESET'))).toBe(true);
    expect(isSshConnectionError(new Error('EPIPE'))).toBe(true);
    expect(isSshConnectionError(new Error('Socket closed'))).toBe(true);
    expect(isSshConnectionError(new Error('Keepalive timeout'))).toBe(true);
    expect(isSshConnectionError(new Error('Command timed out after 60000ms'))).toBe(true);
    expect(isSshConnectionError(new Error('Connection lost'))).toBe(true);
  });

  it('does not match ordinary operational errors', () => {
    expect(isSshConnectionError(new Error('readdir failed: No such file'))).toBe(false);
    expect(isSshConnectionError(new Error('Read timed out after 100ms'))).toBe(false);
    expect(isSshConnectionError(new Error('Permission denied'))).toBe(false);
  });
});
