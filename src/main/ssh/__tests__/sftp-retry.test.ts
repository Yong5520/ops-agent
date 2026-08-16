import { describe, it, expect, vi } from 'vitest';
import { retrySftpOnce } from '../sftp-retry.js';
import { isSshConnectionError } from '../connection-errors.js';

// The terminal SFTP IPC handlers previously had no recovery: one
// "Channel open failure" (zombie connection) and every later SFTP call on
// that host failed until the app restarted. retrySftpOnce invalidates the
// pooled connection and retries exactly once when the error looks like a
// broken connection.

function makeManager(id: string) {
  return { id } as never;
}

describe('retrySftpOnce (v24)', () => {
  it('succeeds without retry or invalidation on the first try', async () => {
    const mgr = makeManager('m1');
    const getManager = vi.fn().mockResolvedValue(mgr);
    const invalidate = vi.fn();
    const op = vi.fn().mockResolvedValue('ok');

    const result = await retrySftpOnce(getManager, invalidate, op, isSshConnectionError);

    expect(result).toBe('ok');
    expect(getManager).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries once on a connection error with a fresh manager', async () => {
    const stale = makeManager('stale');
    const fresh = makeManager('fresh');
    const getManager = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    const invalidate = vi.fn();
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('SFTP error: (SSH) Channel open failure: open failed'))
      .mockResolvedValueOnce('recovered');

    const result = await retrySftpOnce(getManager, invalidate, op, isSshConnectionError);

    expect(result).toBe('recovered');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenNthCalledWith(1, stale);
    expect(op).toHaveBeenNthCalledWith(2, fresh);
  });

  it('does NOT retry ordinary errors (e.g. No such file)', async () => {
    const getManager = vi.fn().mockResolvedValue(makeManager('m1'));
    const invalidate = vi.fn();
    const op = vi.fn().mockRejectedValue(new Error('readdir failed: No such file'));

    await expect(
      retrySftpOnce(getManager, invalidate, op, isSshConnectionError),
    ).rejects.toThrow(/No such file/);
    expect(op).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('gives up after one retry and rethrows the second error', async () => {
    const getManager = vi.fn().mockResolvedValue(makeManager('m1'));
    const invalidate = vi.fn();
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('Socket closed'))
      .mockRejectedValueOnce(new Error('Socket closed again'));

    await expect(
      retrySftpOnce(getManager, invalidate, op, isSshConnectionError),
    ).rejects.toThrow(/Socket closed again/);
    expect(op).toHaveBeenCalledTimes(2);
  });
});
