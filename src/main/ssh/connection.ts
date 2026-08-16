import { Client } from 'ssh2';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { SshClientConfig, ConnectionState } from './types.js';
import type { DeviceType } from '../../shared/types.js';
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

/**
 * Compute the OpenSSH-format SHA256 fingerprint of a host public key.
 * Returns "SHA256:<base64>" with trailing `=` padding stripped, matching
 * `ssh-keygen -lf`. Used by hostVerifier (verify path) + TOFU capture.
 */
export function fingerprintOfHostKey(key: Buffer | string): string {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  return 'SHA256:' + createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

/**
 * Truncate a "SHA256:<base64>" fingerprint for display in error messages.
 * Full fingerprints (~47 chars) flood the UI; the prefix + first 16 base64
 * chars are enough to tell two keys apart. The full expected/actual values
 * are also written to the log via logger.warn in buildConnectConfig.
 */
function truncateFingerprint(fp: string): string {
  return fp.length > 24 ? `${fp.slice(0, 24)}…` : fp;
}

/**
 * Build the ssh2 connect-config object from an SshClientConfig (V3-09 extracted
 * from connect() so it is unit-testable). Pure - no ssh2 Client needed.
 *
 * V3-09: agentForward passthrough + host-key verification / TOFU capture.
 * - hostKeyFingerprint set: verify against it.
 * - hostKeyFingerprint unset but onHostKey provided: TOFU - capture + accept.
 * - neither: no hostVerifier (legacy).
 * The `sock` (jump-host stream) is assigned in connect() after awaiting
 * getJumpStream - not here, because getJumpStream is async.
 */
export function buildConnectConfig(
  config: SshClientConfig,
  opts: {
    onHostKey?: (fingerprint: string) => void;
    onMismatch?: (expected: string, actual: string) => void;
  } = {},
): Record<string, unknown> {
  const connectConfig: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: 30_000,
    keepaliveInterval: 30_000,
    keepaliveCountMax: 3,
  };
  if (config.password) connectConfig.password = config.password;
  if (config.privateKey) connectConfig.privateKey = config.privateKey;
  if (config.passphrase) connectConfig.passphrase = config.passphrase;

  // V3-09: agent forwarding.
  if (config.agentForward) connectConfig.agentForward = true;

  // V3-09.1: encoded-bastion manual target auth. When targetPassword is set,
  // the bastion prompts a second keyboard-interactive round for the target's
  // password. Enable tryKeyboard so ssh2 raises 'keyboard-interactive' events;
  // connect() wires the handler that answers round 1 with the bastion password
  // (config.password) and subsequent rounds with the target password.
  if (config.targetPassword) {
    connectConfig.tryKeyboard = true;
  }

  // V3-09: host-key verification. ssh2 calls hostVerifier(key, verify) during
  // kex; verify(true) accepts, verify(false) rejects (fails the connection).
  if (config.hostKeyFingerprint) {
    const expected = config.hostKeyFingerprint;
    connectConfig.hostVerifier = (key: Buffer | string, verify: (ok: boolean) => void) => {
      const actual = fingerprintOfHostKey(key);
      const ok = actual === expected;
      if (!ok) {
        logger.warn(`[SSH] Host key fingerprint mismatch: expected ${expected}, got ${actual}`);
        // V3-10: surface the actual fingerprints to the connection manager so
        // it can augment ssh2's opaque "Host denied (verification failed)" with
        // a actionable diagnostic + a hint to clear the stale fingerprint.
        opts.onMismatch?.(expected, actual);
      }
      verify(ok);
    };
  } else if (opts.onHostKey) {
    // TOFU: first connect to an unknown host - capture the fingerprint for
    // persistence and accept (verify true) so the connection proceeds.
    const onHostKey = opts.onHostKey;
    connectConfig.hostVerifier = (key: Buffer | string, verify: (ok: boolean) => void) => {
      const actual = fingerprintOfHostKey(key);
      logger.info(`[SSH] TOFU: recording host key fingerprint ${actual}`);
      onHostKey(actual);
      verify(true);
    };
  }

  return connectConfig;
}

export class SSHConnectionManager extends EventEmitter {
  private conn: Client | null = null;
  private readonly config: SshClientConfig;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;
  // V3-09: TOFU host-key capture callback. Set by the pool so the first
  // connection to an unverified host can record its fingerprint for persistence.
  onHostKey?: (fingerprint: string) => void;
  // Persistent su shell stream (when suPassword is configured)
  private suShell: {
    write: (data: string) => void;
    end: () => void;
    on: (e: string, cb: (d: Buffer) => void) => void;
    removeAllListeners: (e?: string) => void;
  } | null = null;
  private suPromise: Promise<void> | null = null;
  private isElevated = false;
  // V3-10: populated by the hostVerifier callback when a stored fingerprint
  // mismatches the server's current key. Read by the 'error' handler to
  // augment ssh2's opaque "Host denied (verification failed)" with the actual
  // fingerprints + a hint to clear the stale record. Reset on each connect().
  private hostKeyMismatch: { expected: string; actual: string } | null = null;
  private state: ConnectionState = 'disconnected';

  // v24 activity mirror: session context stamped by the agent tools before
  // each exec so raw-chunk mirror events can be scoped to a session in the
  // UI. Defaults to '' (events land in a shared bucket every view can show).
  mirrorSessionId: string = '';

  constructor(
    public readonly hostId: string,
    public readonly hostName: string,
    config: SshClientConfig,
  ) {
    super();
    this.config = config;
  }

  /** id alias used by the activity-mirror tap (executor records hostId). */
  get id(): string {
    return this.hostId;
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

  // Device type drives the exec profile (PTY for network-device CLIs). Defaults
  // to 'linux' (no-PTY) when unset so old configs behave as before.
  get deviceType(): DeviceType {
    return this.config.deviceType ?? 'linux';
  }

  getState(): ConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    if (this.conn === null) return false;
    // Check TCP socket health
    const sock = (this.conn as unknown as { _sock?: { destroyed?: boolean } })._sock;
    if (!sock) return false;
    if (sock.destroyed) return false;
    // Check ssh2 Client internal state - if the client has emitted 'end'
    // or 'close', the connection is dead even if the socket isn't marked
    // as destroyed yet.
    // The ssh2 library sets _sock.writable to false when the SSH layer
    // is broken, even if the TCP socket is still technically open.
    if ('writable' in sock && !sock.writable) return false;
    return true;
  }

  // Force-close the connection and reset state. Used when exec failures
  // indicate the SSH session layer is broken (e.g., channel exhaustion).
  // The next pool.get() will create a fresh connection.
  forceClose(): void {
    if (this.conn) {
      try {
        this.conn.end();
      } catch {
        // ignore - connection may already be dead
      }
      this.conn = null;
      this.isConnecting = false;
      this.connectionPromise = null;
      this.setState('disconnected');
    }
  }

  async connect(): Promise<void> {
    if (this.conn && this.isConnected()) return;
    if (this.isConnecting && this.connectionPromise) return this.connectionPromise;

    this.isConnecting = true;
    this.setState('connecting');
    // V3-10: clear any stale mismatch info from a previous attempt so the
    // error handler doesn't surface a stale diagnostic.
    this.hostKeyMismatch = null;

    // V3-09: obtain the jump-host stream BEFORE constructing the connect
    // promise (the promise executor is synchronous, so it cannot await).
    // The stream is then passed as `sock` to ssh2.Client.connect().
    let jumpSock: unknown;
    if (this.config.getJumpStream) {
      try {
        jumpSock = await this.config.getJumpStream();
      } catch (err) {
        this.isConnecting = false;
        this.setState('error', (err as Error).message);
        throw err instanceof OpsAgentError
          ? err
          : new OpsAgentError((err as Error).message, 'SSH_ERROR');
      }
    }

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
        // V3-10: if the hostVerifier recorded a fingerprint mismatch, append
        // the actual fingerprints + a recovery hint. ssh2's raw message
        // "Host denied (verification failed)" gives the user no clue why or
        // how to recover (the stored fingerprint is stale). Note: in encoded-
        // bastion mode the verified fingerprint is the bastion's (stored on
        // the bastion's host record), so the hint covers both cases.
        const message = this.hostKeyMismatch
          ? `${err.message}（主机密钥不匹配：期望 ${truncateFingerprint(this.hostKeyMismatch.expected)}，实际 ${truncateFingerprint(this.hostKeyMismatch.actual)}。请在主机配置中清除主机密钥后重试；若使用堡垒机编码模式，请清除堡垒机的主机密钥）`
          : err.message;
        reject(new OpsAgentError(`[${this.hostName}] SSH error: ${message}`, 'SSH_ERROR'));
      });

      // V3-09.1: encoded-bastion manual target auth. The bastion issues a
      // keyboard-interactive challenge: if the bastion uses password auth, round
      // 1 = bastion password and round 2+ = target password. If the bastion uses
      // key auth (no config.password), ssh2 skips the bastion keyboard round, so
      // round 1 = the target's prompt -> answer with the target password. Best-
      // effort: prompt/round detection is bastion-specific; if the bastion only
      // does one round, the unused password is simply not sent.
      if (this.config.targetPassword) {
        const bastionPassword = this.config.password;
        const targetPassword = this.config.targetPassword;
        const bastionUsesPassword = !!bastionPassword;
        let kbdRound = 0;
        this.conn!.on(
          'keyboard-interactive',
          (
            _name: string,
            _instructions: string,
            _lang: string,
            prompts: Array<{ prompt: string }>,
            finish: (answers: string[]) => void,
          ) => {
            kbdRound += 1;
            const answers = prompts.map(() => {
              // Bastion-password round only exists when the bastion uses
              // password auth; otherwise the first round IS the target.
              const isBastionRound = bastionUsesPassword && kbdRound === 1;
              return isBastionRound ? (bastionPassword ?? '') : (targetPassword ?? '');
            });
            finish(answers);
          },
        );
      }

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

      const connectConfig = buildConnectConfig(this.config, {
        onHostKey: this.onHostKey,
        onMismatch: (expected, actual) => {
          this.hostKeyMismatch = { expected, actual };
        },
      });

      // V3-09: jump/bastion host - pass the stream obtained above as `sock` so
      // ssh2 tunnels the target connection through the bastion.
      if (jumpSock !== undefined) {
        connectConfig.sock = jumpSock;
      }

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
