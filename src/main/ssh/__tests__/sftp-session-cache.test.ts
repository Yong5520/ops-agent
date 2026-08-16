import { describe, it, expect } from 'vitest';
import { getSftp, invalidateSftp } from '../sftp.js';
import type { SFTPWrapper } from 'ssh2';

// The v24 SFTP channel-leak fix: every listDir/realpath/upload/download used
// to open a NEW sftp channel and never end() it, so a browsing session
// exhausted the server's MaxSessions and every later channel open failed
// with "(SSH) Channel open failure: open failed". getSftp now caches ONE
// channel per connection manager.

function makeFakeManager() {
  let opens = 0;
  const manager = {
    ensureConnected: async () => {},
    getConnection: () => ({
      sftp: (cb: (err: Error | null, sftp?: SFTPWrapper) => void) => {
        opens += 1;
        cb(null, { end: () => {} } as unknown as SFTPWrapper);
      },
    }),
    __openCount: () => opens,
  };
  return manager;
}

function makeFailingManager() {
  const manager = {
    ensureConnected: async () => {},
    getConnection: () => ({
      sftp: (cb: (err: Error | null) => void) => {
        cb(new Error('(SSH) Channel open failure: open failed'));
      },
    }),
  };
  return manager;
}

describe('getSftp per-manager channel cache (v24)', () => {
  it('reuses one channel across sequential calls', async () => {
    const mgr = makeFakeManager();
    const a = await getSftp(mgr as never);
    const b = await getSftp(mgr as never);
    expect(a).toBe(b);
    expect(mgr.__openCount()).toBe(1);
  });

  it('opens a fresh channel after invalidateSftp (and ends the old one)', async () => {
    const mgr = makeFakeManager();
    const a = await getSftp(mgr as never);
    invalidateSftp(mgr as never);
    const b = await getSftp(mgr as never);
    expect(b).not.toBe(a);
    expect(mgr.__openCount()).toBe(2);
  });

  it('does not cache a failed open', async () => {
    const mgr = makeFailingManager();
    await expect(getSftp(mgr as never)).rejects.toThrow(/Channel open failure/);
    // A retry opens again rather than reusing a poisoned cache entry.
    await expect(getSftp(mgr as never)).rejects.toThrow(/Channel open failure/);
  });

  it('invalidating an unknown manager is a no-op', () => {
    expect(() => invalidateSftp({} as never)).not.toThrow();
  });
});
