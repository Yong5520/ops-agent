/**
 * Shared SSH connection-error detection (v24).
 *
 * Extracted from agent/tools.ts so both the AI exec tools and the terminal
 * SFTP IPC handlers can decide whether a failure means the underlying SSH
 * connection is a zombie (TCP alive, SSH layer dead) that must be
 * invalidated and re-established.
 */

/**
 * Whether this error indicates the SSH connection is broken and should be
 * invalidated. Covers zombie connections where the TCP socket is alive but
 * the SSH session layer is unusable.
 *
 * IMPORTANT: OpsAgentError stores the error category in `.code` (e.g.
 * 'SSH_TIMEOUT'), not in `.message`. The message text is user-facing (e.g.
 * "Command timed out after 60000ms") and does NOT contain the code string.
 * We must check both .code and .message to catch all cases.
 */
export function isSshConnectionError(err: Error): boolean {
  // Check OpsAgentError.code first (authoritative category).
  const code = (err as { code?: string }).code;
  if (code === 'SSH_TIMEOUT' || code === 'SSH_NOT_CONNECTED') return true;

  const msg = err.message;
  if (msg.includes('channel') || msg.includes('Channel')) return true;
  if (msg.includes('MaxSessions')) return true;
  if (msg.includes('ECONNRESET')) return true;
  if (msg.includes('EPIPE')) return true;
  if (msg.includes('Socket closed')) return true;
  if (msg.includes('Keepalive timeout')) return true;
  if (msg.includes('Command timed out')) return true;
  if (msg.includes('Connection lost')) return true;
  return false;
}
