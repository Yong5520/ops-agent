// SerialConnectionManager - manages one serial-port console connection to a
// serial host (e.g. a switch's console port for initialization work).
//
// Mirrors SSHConnectionManager's role but for a byte-stream console:
//   - connect(): open the port, wake the console, optionally auto-login
//     (login-state-machine.ts) and wait until a CLI prompt is reachable.
//   - exec(): expect-style command execution - send `command\r`, collect
//     output, auto-advance the pager, finish when the prompt returns (with a
//     quiet-period guard so slow output is not cut short).
//   - subscribe()/write(): raw passthrough for an interactive terminal. The
//     port is a singleton per host (serial ports cannot be opened twice), so
//     the terminal and AI exec share one manager; exec output is broadcast to
//     subscribers, letting the user watch the AI work on the console.
//
// The port is created via an injectable factory so tests script a FakeSerialPort
// instead of needing hardware.

import type { HostConfig } from '../../shared/types.js';
import type { ExecResult, ExecStreamCallback } from '../ssh/types.js';
import { stripAnsi, stripPagerArtifacts, createPagerAdvancer } from '../ssh/pager.js';
import { resolveSerialOptions, type ResolvedSerialOptions } from './serial-options.js';
import { detectBootPrompt, endsWithCliPrompt } from './serial-prompts.js';
import { createLoginDriver } from './login-state-machine.js';
import { logger } from '../utils/logger.js';

/** The subset of serialport's API the manager uses (structural - FakeSerialPort
 * satisfies it in tests, real SerialPort in production). */
export interface SerialPortLike {
  on(event: 'open' | 'close', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'data', cb: (data: Buffer) => void): unknown;
  write(data: string): boolean | void;
  close(cb?: (err?: Error | null) => void): void;
}

export type SerialPortFactory = (options: ResolvedSerialOptions) => SerialPortLike;

/** Default port factory: the real serialport package (lazy-required so vitest
 * never loads the native binding). */
function createRealSerialPort(options: ResolvedSerialOptions): SerialPortLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SerialPort } = require('serialport') as {
    SerialPort: new (opts: Record<string, unknown>) => unknown;
  };
  return new SerialPort({ ...options, autoOpen: true }) as SerialPortLike;
}

export interface SerialManagerOptions {
  createPort?: SerialPortFactory;
  /** Quiet period after which a seen CLI prompt completes an exec. */
  quietMs?: number;
  /** How long connect() waits for the console to reach a prompt without
   * login before proceeding anyway (odd boot screens). Default 5s. */
  readyTimeoutMs?: number;
  /** How long connect() waits for the auto-login sequence. Default 30s. */
  loginTimeoutMs?: number;
  /** How long connect() waits for the port to open. Default 10s. */
  openTimeoutMs?: number;
  /** Max bytes collected by one exec before finishing (runaway guard). */
  maxCollectBytes?: number;
}

const DEFAULT_QUIET_MS = 400;
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 30_000;
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_COLLECT_BYTES = 4 * 1024 * 1024;
const MAX_BOOT_PRESSES = 3;

// Prompt-shaped single lines (for stripping the trailing prompt from exec
// output): <name>, [name], name# / name> / name(cfg)#.
const PROMPT_LINE_RES: RegExp[] = [
  /^<[^<>\r\n]{1,64}>$/,
  /^\[[^[\]\r\n]{1,64}\]$/,
  /^[A-Za-z0-9][\w.-]{0,63}(?:\([^\r\n()]{0,48}\))?[>#]$/,
];

function isPromptLine(line: string): boolean {
  const trimmed = line.trim();
  return !!trimmed && PROMPT_LINE_RES.some((re) => re.test(trimmed));
}

export class SerialConnectionManager {
  readonly id: string;
  readonly hostName: string;
  private readonly host: HostConfig;
  private readonly createPort: SerialPortFactory;
  private readonly quietMs: number;
  private readonly readyTimeoutMs: number;
  private readonly loginTimeoutMs: number;
  private readonly openTimeoutMs: number;
  private readonly maxCollectBytes: number;

  private port: SerialPortLike | null = null;
  private connected = false;
  private closeRequested = false;
  // Notified when the port closes unexpectedly (unplug / another program took
  // the port) - NOT on our own close(). The terminal uses this to surface an
  // exit event.
  private onPortClosed: (() => void) | null = null;
  // Current data consumer: the login/boot reader during connect(), the exec
  // collector during exec(), null otherwise. Terminal subscribers always get
  // raw output regardless of the active reader.
  private activeReader: ((chunk: string) => void) | null = null;
  private subscribers = new Set<(data: string) => void>();
  // Exec serialization: one console, one command at a time.
  private execChain: Promise<unknown> = Promise.resolve();

  constructor(host: HostConfig, opts: SerialManagerOptions = {}) {
    this.host = host;
    this.id = host.id;
    this.hostName = host.name;
    this.createPort = opts.createPort ?? createRealSerialPort;
    this.quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.loginTimeoutMs = opts.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.openTimeoutMs = opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.maxCollectBytes = opts.maxCollectBytes ?? DEFAULT_MAX_COLLECT_BYTES;
  }

  get deviceType(): HostConfig['deviceType'] {
    return this.host.deviceType;
  }

  /** Host command timeout (used as the default exec timeout). */
  get timeout(): number {
    return this.host.timeoutMs;
  }

  isConnected(): boolean {
    return this.connected && !this.closeRequested;
  }

  /**
   * Open the port and bring the console to a usable state: wake it with a
   * newline, auto-login when the host is configured with loginRequired, and
   * wait for a CLI prompt (or a timeout, for no-login hosts).
   */
  async connect(): Promise<void> {
    if (this.isConnected()) return;

    const options = resolveSerialOptions(this.host);
    await this.openPort(options);
    this.connected = true;
    this.closeRequested = false;
    logger.info(`[Serial] Opened ${options.path} @ ${options.baudRate} for ${this.hostName}`);

    try {
      await this.ensureReady();
    } catch (err) {
      // A console that never became usable is not a connection we want to
      // keep - close so a retry starts clean.
      this.close();
      throw err;
    }
  }

  private openPort(options: ResolvedSerialOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let port: SerialPortLike;
      try {
        port = this.createPort(options);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          port.close();
        } catch {
          // ignore
        }
        reject(new Error(`串口 ${options.path} 打开超时`));
      }, this.openTimeoutMs);

      port.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`串口 ${options.path} 打开失败: ${err.message}`));
      });
      port.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.port = port;
        this.wirePort(port);
        resolve();
      });
      port.on('close', () => {
        if (!settled) return;
        // Close after a successful open (unplug, external program stole the
        // port, or our own close()).
        this.connected = false;
        this.activeReader = null;
        logger.info(`[Serial] Port closed for ${this.hostName}`);
        if (!this.closeRequested) this.onPortClosed?.();
      });
    });
  }

  private wirePort(port: SerialPortLike): void {
    port.on('data', (data: Buffer) => {
      const text = data.toString('utf8');
      for (const cb of this.subscribers) {
        try {
          cb(text);
        } catch (err) {
          logger.warn(`[Serial] Subscriber error on ${this.hostName}: ${(err as Error).message}`);
        }
      }
      this.activeReader?.(text);
    });
  }

  /**
   * Wake the console and drive it to a prompt. loginRequired hosts run the
   * auto-login state machine (rejecting on failure); no-login hosts just wait
   * briefly for a prompt and proceed regardless (fresh-boot screens vary too
   * much to hard-require a known prompt shape).
   */
  private ensureReady(): Promise<void> {
    // Wake: many consoles stay silent until they receive input.
    this.write('\r');

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.activeReader = null;
          if (this.host.loginRequired) {
            reject(new Error(`串口 ${this.hostName} 自动登录超时`));
          } else {
            resolve();
          }
        },
        this.host.loginRequired ? this.loginTimeoutMs : this.readyTimeoutMs,
      );

      const finish = (): void => {
        clearTimeout(timer);
        this.activeReader = null;
        resolve();
      };

      if (this.host.loginRequired) {
        const driver = createLoginDriver({
          username: this.host.username ?? '',
          password: this.host.password ?? '',
        });
        this.activeReader = (chunk) => {
          const actions = driver.feed(chunk);
          for (const action of actions) this.write(action.data);
          const state = driver.getState();
          if (state === 'ready') finish();
          else if (state === 'failed') {
            clearTimeout(timer);
            this.activeReader = null;
            reject(new Error(`串口 ${this.hostName} 登录失败（凭据被拒绝）`));
          }
        };
      } else {
        let bootPresses = 0;
        let recent = '';
        this.activeReader = (chunk) => {
          recent += chunk;
          if (recent.length > 512) recent = recent.slice(-512);
          if (detectBootPrompt(recent) && bootPresses < MAX_BOOT_PRESSES) {
            bootPresses += 1;
            recent = '';
            this.write('\r');
            return;
          }
          if (endsWithCliPrompt(recent)) finish();
        };
      }
    });
  }

  /**
   * Expect-style exec: send `command\r`, collect the output, auto-advance the
   * pager, and finish when the prompt returns (quiet-period guard). Serial
   * consoles have no exit codes - exitCode is always null; on timeout the
   * partial output collected so far is returned (empty output rejects).
   */
  exec(
    command: string,
    opts: { onStream?: ExecStreamCallback; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    // Serialize: a serial console can only run one command at a time. The
    // chain swallows rejections so a failed exec doesn't poison the queue.
    const run = this.execChain.then(
      () => this.doExec(command, opts),
      () => this.doExec(command, opts),
    );
    this.execChain = run.catch(() => undefined);
    return run;
  }

  private async doExec(
    command: string,
    opts: { onStream?: ExecStreamCallback; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ExecResult> {
    if (!this.isConnected() || !this.port) {
      throw new Error(`串口 ${this.hostName} 未连接`);
    }
    const timeoutMs = opts.timeoutMs ?? this.host.timeoutMs;
    const start = Date.now();

    return new Promise<ExecResult>((resolve) => {
      let buffer = '';
      let sawPrompt = false;
      let settledLocal = false;

      const advancer = createPagerAdvancer({ onAdvance: () => this.write(' ') });

      const cleanup = (): void => {
        clearTimeout(timeoutId);
        clearTimeout(quietId);
        opts.signal?.removeEventListener('abort', onAbort);
        if (this.activeReader === reader) this.activeReader = null;
      };

      const finish = (aborted: boolean): void => {
        if (settledLocal) return;
        settledLocal = true;
        cleanup();
        resolve({
          stdout: cleanOutput(buffer, command),
          stderr: '',
          exitCode: null,
          durationMs: Date.now() - start,
          viaSuShell: false,
          ...(aborted ? { aborted: true } : {}),
        });
      };

      const reader = (chunk: string): void => {
        buffer += chunk;
        if (buffer.length > this.maxCollectBytes) {
          finish(false);
          return;
        }
        advancer.consumeChunk(chunk);
        opts.onStream?.({ stream: 'stdout', data: stripPagerArtifacts(stripAnsi(chunk)) });
        sawPrompt = sawPrompt || endsWithCliPrompt(buffer);
        // Quiet-period guard: a prompt seen AND output quiet -> command done.
        // Without the quiet guard, a prompt echoed mid-output would truncate.
        clearTimeout(quietId);
        quietId = setTimeout(() => {
          if (sawPrompt) finish(false);
        }, this.quietMs);
      };

      const timeoutId = setTimeout(() => {
        // Partial output beats an opaque timeout error on a console; an empty
        // buffer means nothing came back - surface a timeout error instead.
        if (buffer.trim()) {
          finish(false);
        } else {
          if (settledLocal) return;
          settledLocal = true;
          cleanup();
          resolve({
            stdout: '',
            stderr: `串口 ${this.hostName} 命令 ${timeoutMs}ms 内无输出`,
            exitCode: null,
            durationMs: Date.now() - start,
            viaSuShell: false,
          });
        }
      }, timeoutMs);

      const onAbort = (): void => finish(true);
      opts.signal?.addEventListener('abort', onAbort);

      let quietId = setTimeout(() => {
        // Nothing arrived within the first quiet window - keep waiting for
        // the overall timeout; this branch is a no-op placeholder.
      }, this.quietMs);

      this.activeReader = reader;
      this.write(command + '\r');
    });
  }

  /** Raw passthrough for an interactive terminal. */
  write(data: string): void {
    if (this.port && this.connected) {
      this.port.write(data);
    }
  }

  /** Register a callback for unexpected port closure (see onPortClosed). */
  setOnPortClosed(cb: (() => void) | null): void {
    this.onPortClosed = cb;
  }

  /** Subscribe to raw console output (terminal mirror). Returns unsubscribe. */
  subscribe(cb: (data: string) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  close(): void {
    this.closeRequested = true;
    this.connected = false;
    this.activeReader = null;
    if (this.port) {
      try {
        this.port.close();
      } catch {
        // already closed
      }
      this.port = null;
    }
  }
}

/**
 * Clean exec output for the model: strip ANSI + pager prompts, drop the echoed
 * command line and the trailing prompt line.
 */
function cleanOutput(buffer: string, command: string): string {
  const cleaned = stripPagerArtifacts(stripAnsi(buffer));
  const lines = cleaned.split(/\r?\n/);
  // Drop the echoed command (the console echoes what we sent).
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first >= 0) {
    const echo = lines[first].trim();
    if (echo === command.trim() || echo.startsWith(command.trim())) {
      lines.splice(first, 1);
    }
  }
  // Drop the trailing prompt line.
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length && isPromptLine(lines[lines.length - 1])) lines.pop();
  return lines.join('\n').trim();
}
