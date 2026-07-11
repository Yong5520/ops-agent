import { Client } from 'ssh2';
import { EventEmitter } from 'node:events';
import type { SshClientConfig, ConnectionState } from './types.js';
import { logger } from '../utils/logger.js';

// SSHConnectionManager manages a single SSH connection to one host.
// Extracted from ssh-mcp-multi SSHConnectionManager (lines 329-449) with:
//   - McpError replaced by plain Error
//   - EventEmitter for state changes
//   - Strong typing for sshConfig
//   - su elevation logic preserved

export class OpsAgentError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'SSH_ERROR'
      | 'SSH_TIMEOUT'
      | 'SSH_AUTH'
      | 'SSH_NOT_CONNECTED'
      | 'INVALID_PARAMS' = 'SSH_ERROR',
  ) {
    super(message);
    this.name = 'OpsAgentError';
  }
}

export class SSHConnectionManager extends EventEmitter {
  private conn: Client | null = null;
  private readonly config: SshClientConfig;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;
  // Persistent su shell stream (when suPassword is configured)
  private suShell: {
    write: (data: string) => void;
    end: () => void;
    on: (e: string, cb: (d: Buffer) => void) => void;
    removeAllListeners: (e?: string) => void;
  } | null = null;
  private suPromise: Promise<void> | null = null;
  private isElevated = false;
  private state: ConnectionState = 'disconnected';

  constructor(
    public readonly hostId: string,
    public readonly hostName: string,
    config: SshClientConfig,
  ) {
    super();
    this.config = config;
  }

  get timeout(): number {
    return this.config.timeoutMs;
  }

  get sudoPassword(): string | undefined {
    return this.config.sudoPassword;
  }

  get suPassword(): string | undefined {
    return this.config.suPassword;
  }

  getState(): ConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return (
      this.conn !== null &&
      !!(this.conn as unknown as { _sock?: { destroyed?: boolean } })._sock &&
      !(this.conn as unknown as { _sock?: { destroyed?: boolean } })._sock?.destroyed
    );
  }

  async connect(): Promise<void> {
    if (this.conn && this.isConnected()) return;
    if (this.isConnecting && this.connectionPromise) return this.connectionPromise;

    this.isConnecting = true;
    this.setState('connecting');

    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.conn = new Client();
      const timeoutId = setTimeout(() => {
        this.conn?.end();
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.setState('error', 'SSH connection timeout');
        reject(new OpsAgentError(`[${this.hostName}] SSH connection timeout`, 'SSH_TIMEOUT'));
      }, 30_000);

      this.conn!.on('ready', async () => {
        clearTimeout(timeoutId);
        this.isConnecting = false;
        this.setState('connected');
        logger.info(`[${this.hostName}] SSH connected`);
        // If suPassword is set, try to elevate via su -. Non-fatal on failure.
        if (this.config.suPassword) {
          try {
            await this.ensureElevated();
          } catch (err) {
            logger.warn(
              `[${this.hostName}] su elevation failed (non-fatal): ${(err as Error).message}`,
            );
          }
        }
        resolve();
      });

      this.conn!.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.setState('error', err.message);
        logger.error(`[${this.hostName}] SSH error: ${err.message}`);
        reject(new OpsAgentError(`[${this.hostName}] SSH error: ${err.message}`, 'SSH_ERROR'));
      });

      this.conn!.on('end', () => {
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.setState('disconnected');
      });
      this.conn!.on('close', () => {
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.setState('disconnected');
      });

      const connectConfig: Record<string, unknown> = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        readyTimeout: 30_000,
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
      };
      if (this.config.password) connectConfig.password = this.config.password;
      if (this.config.privateKey) connectConfig.privateKey = this.config.privateKey;
      if (this.config.passphrase) connectConfig.passphrase = this.config.passphrase;

      this.conn!.connect(connectConfig);
    });
    return this.connectionPromise;
  }

  async ensureConnected(): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }
  }

  getConnection(): Client {
    if (!this.conn) {
      throw new OpsAgentError(
        `[${this.hostName}] SSH connection not established`,
        'SSH_NOT_CONNECTED',
      );
    }
    return this.conn;
  }

  // ── su elevation ────────────────────────────────────────────────────────
  // Opens a persistent `su -` shell and feeds it the suPassword. Subsequent
  // commands can be written to this shell to run as root without re-auth.

  async ensureElevated(): Promise<void> {
    if (this.isElevated && this.suShell) return;
    const suPassword = this.config.suPassword;
    if (!suPassword) return;
    if (this.suPromise) return this.suPromise;

    this.suPromise = new Promise<void>((resolve, reject) => {
      const conn = this.getConnection();
      const timeoutId = setTimeout(() => {
        this.suPromise = null;
        this.setState('error', 'su elevation timed out');
        reject(new OpsAgentError(`[${this.hostName}] su elevation timed out`, 'SSH_TIMEOUT'));
      }, 10_000);

      conn.shell({ term: 'xterm', cols: 80, rows: 24 }, (err, stream) => {
        if (err) {
          clearTimeout(timeoutId);
          this.suPromise = null;
          reject(new OpsAgentError(`su shell failed: ${err.message}`, 'SSH_ERROR'));
          return;
        }

        let buffer = '';
        let passwordSent = false;
        const cleanup = () => {
          try {
            stream.removeAllListeners('data');
          } catch {
            // ignore
          }
        };

        const onData = (data: Buffer) => {
          buffer += data.toString();
          if (!passwordSent && /password[: ]/i.test(buffer)) {
            passwordSent = true;
            stream.write(suPassword + '\n');
          }
          if (passwordSent && /#/.test(buffer)) {
            clearTimeout(timeoutId);
            cleanup();
            this.suShell = stream;
            this.isElevated = true;
            this.suPromise = null;
            logger.info(`[${this.hostName}] su elevation successful`);
            resolve();
            return;
          }
          if (/authentication failure|incorrect password|su: .*failed|su: failure/i.test(buffer)) {
            clearTimeout(timeoutId);
            cleanup();
            this.suPromise = null;
            reject(new OpsAgentError(`su auth failed: ${buffer}`, 'SSH_AUTH'));
          }
        };
        stream.on('data', onData);
        stream.on('close', () => {
          if (!this.isElevated) {
            this.suPromise = null;
            reject(new OpsAgentError('su shell closed before elevation', 'SSH_ERROR'));
          }
        });
        stream.write('su -\n');
      });
    });
    return this.suPromise;
  }

  // Expose the su shell for the executor to use.
  getSuShell(): typeof this.suShell {
    return this.suShell;
  }

  close(): void {
    if (this.suShell) {
      try {
        this.suShell.end();
      } catch {
        // ignore
      }
      this.suShell = null;
      this.isElevated = false;
    }
    if (this.conn) {
      this.conn.end();
      this.conn = null;
    }
    this.setState('disconnected');
  }

  private setState(state: ConnectionState, error?: string): void {
    this.state = state;
    this.emit('stateChange', {
      hostId: this.hostId,
      hostName: this.hostName,
      state,
      error,
      timestamp: new Date().toISOString(),
    });
  }
}
