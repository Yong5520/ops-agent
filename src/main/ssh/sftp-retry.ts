/**
 * One-shot retry for SFTP IPC handlers (v24).
 *
 * The terminal SFTP handlers previously had no recovery: a single
 * "Channel open failure: open failed" (zombie connection, e.g. after the
 * server hit MaxSessions) left every later SFTP call on that host failing
 * until the app restarted, because the pooled connection stayed alive and
 * kept being reused. This helper invalidates the pooled connection and
 * retries exactly once - only for errors that look like a broken connection.
 */

/**
 * Run `op` with a manager from `getManager`. If it fails with a
 * connection-style error, call `invalidate()`, fetch a fresh manager and
 * retry exactly once. Ordinary errors (No such file, permission denied...)
 * are rethrown untouched.
 */
export async function retrySftpOnce<M, T>(
  getManager: () => Promise<M>,
  invalidate: () => void,
  op: (manager: M) => Promise<T>,
  isConnectionError: (err: Error) => boolean,
): Promise<T> {
  const first = await getManager();
  try {
    return await op(first);
  } catch (err) {
    const error = err as Error;
    if (!isConnectionError(error)) throw error;
    invalidate();
    const fresh = await getManager();
    return await op(fresh);
  }
}
