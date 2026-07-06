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
}

// Streaming callback invoked as stdout/stderr chunks arrive.
export type ExecStreamCallback = (chunk: {
  stream: 'stdout' | 'stderr';
  data: string;
}) => void;

// Re-export ssh2 types for convenience.
export type { Client, SFTPWrapper };
