import type { Client } from 'ssh2';
import type { SFTPWrapper } from 'ssh2';

// SSH connection configuration passed to ssh2.Client.connect().
// Built from a HostConfig record (decrypted from DB) by the connection pool.
export interface SshClientConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  sudoPassword?: string;
  suPassword?: string;
  timeoutMs: number;
  // V3-09: SSH bastion / agent forwarding / host-key verification.
  /** Enable OpenSSH agent forwarding on this connection. */
  agentForward?: boolean;
  /** Expected SHA256 host-key fingerprint. connection.ts builds the
   * hostVerifier callback from this; empty = TOFU (record on first connect). */
  hostKeyFingerprint?: string;
  /** When set, connection.ts awaits this to obtain a stream from the jump host
   * and passes it as `sock` to ssh2.Client.connect() (cascaded connection). */
  getJumpStream?: () => Promise<unknown>;
}

// Connection state machine values.
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// Event payload emitted by SSHConnectionManager and ConnectionPool.
export interface ConnectionEvent {
  hostId: string;
  hostName: string;
  state: ConnectionState;
  error?: string;
  timestamp: string;
}

// Result of a command execution.
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  // True if the command was executed via the persistent su shell.
  viaSuShell: boolean;
  // V3-07 Cycle B: true if the command was cancelled via AbortSignal (stop_tail
  // / UI stop button). exitCode is null in that case; stdout/stderr hold the
  // partial output accumulated before the abort.
  aborted?: boolean;
}

// Streaming callback invoked as stdout/stderr chunks arrive.
export type ExecStreamCallback = (chunk: { stream: 'stdout' | 'stderr'; data: string }) => void;

// Re-export ssh2 types for convenience.
export type { Client, SFTPWrapper };
