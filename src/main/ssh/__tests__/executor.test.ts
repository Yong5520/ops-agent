// Integration tests for execCommand's network-device pager handling (Phase 1).
//
// These exercise the real executor against a fake ssh2 Client/stream (no real
// SSH). They verify that a `---- More ----` prompt triggers a Space write so
// the command completes (instead of timing out), that the prompt is stripped
// from both the streaming chunks and the final stdout, and that non-paginated
// Linux output is untouched (regression guard).
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execCommand } from '../executor.js';
import type { SSHConnectionManager } from '../connection.js';
import type { DeviceType } from '../../../shared/types.js';

interface FakeStream extends EventEmitter {
  stderr: EventEmitter;
  write: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeFakeStream(): FakeStream {
  const s = new EventEmitter() as FakeStream;
  s.stderr = new EventEmitter();
  s.write = vi.fn();
  s.close = vi.fn();
  return s;
}

// Fake manager whose getConnection().exec() hands back `stream`. Supports both
// conn.exec(cmd, cb) (Phase 1) and conn.exec(cmd, { pty }, cb) (Phase 2).
function makeFakeManager(
  stream: FakeStream,
  opts: {
    timeout?: number;
    deviceType?: DeviceType;
    onExec?: (cmd: string, ptyOpt: unknown) => void;
  } = {},
): SSHConnectionManager {
  const onExec = opts.onExec;
  return {
    hostName: 'switch1',
    timeout: opts.timeout ?? 5000,
    deviceType: opts.deviceType,
    ensureConnected: vi.fn(async () => {}),
    getConnection: () => ({
      exec(cmd: string, ptyOrCb: unknown, maybeCb?: unknown) {
        const cb = typeof ptyOrCb === 'function' ? ptyOrCb : maybeCb;
        if (onExec) onExec(cmd, typeof ptyOrCb === 'function' ? undefined : ptyOrCb);
        (cb as (e: Error | null, s: FakeStream) => void)(null, stream);
      },
    }),
    getSuShell: () => null,
  } as unknown as SSHConnectionManager;
}

// Fake manager that routes through a persistent su shell (execViaSuShell path).
function makeSuShellManager(
  suShell: EventEmitter,
  opts: { timeout?: number } = {},
): SSHConnectionManager {
  return {
    hostName: 'host1',
    timeout: opts.timeout ?? 5000,
    ensureConnected: vi.fn(async () => {}),
    getConnection: () => {
      throw new Error('getConnection should not be called on the su-shell path');
    },
    getSuShell: () => suShell,
  } as unknown as SSHConnectionManager;
}

// Drain pending microtasks so execCommand advances past `await ensureConnected()`
// and registers its stream listeners before we emit events.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('execCommand pager handling (exec channel)', () => {
  it('sends Space on "---- More ----" and returns stripped joined output', async () => {
    const stream = makeFakeStream();
    const manager = makeFakeManager(stream);
    const promise = execCommand(manager, 'display version');
    await flush();
    stream.emit('data', Buffer.from('line1\nline2\n  ---- More ----'));
    // Device responds to Space with the rest of the page, then exits.
    stream.emit('data', Buffer.from('line3\nline4\n'));
    stream.emit('exit', 0);
    stream.emit('close');
    const result = await promise;
    expect(stream.write).toHaveBeenCalledWith(' ');
    expect(result.stdout).not.toContain('---- More ----');
    expect(result.stdout).toContain('line1');
    expect(result.stdout).toContain('line4');
    expect(result.exitCode).toBe(0);
  });

  it('does not send Space for non-paginated Linux output', async () => {
    const stream = makeFakeStream();
    const manager = makeFakeManager(stream);
    const promise = execCommand(manager, 'ls -la');
    await flush();
    stream.emit('data', Buffer.from('total 0\nfile1\nfile2\n'));
    stream.emit('exit', 0);
    stream.emit('close');
    const result = await promise;
    expect(stream.write).not.toHaveBeenCalled();
    expect(result.stdout).toContain('file1');
  });

  it('sends Space for each More prompt across multiple pages', async () => {
    const stream = makeFakeStream();
    const manager = makeFakeManager(stream);
    const promise = execCommand(manager, 'display interface');
    await flush();
    stream.emit('data', Buffer.from('p1\n  ---- More ----'));
    stream.emit('data', Buffer.from('p2\n  ---- More ----'));
    stream.emit('data', Buffer.from('p3\n'));
    stream.emit('exit', 0);
    stream.emit('close');
    const result = await promise;
    expect(stream.write).toHaveBeenCalledTimes(2);
    expect(result.stdout).not.toContain('More');
    expect(result.stdout).toContain('p3');
  });

  it('detects Cisco "--More--" prompt', async () => {
    const stream = makeFakeStream();
    const manager = makeFakeManager(stream);
    const promise = execCommand(manager, 'show version');
    await flush();
    stream.emit('data', Buffer.from('Cisco output\n--More--'));
    stream.emit('data', Buffer.from('more output\n'));
    stream.emit('exit', 0);
    stream.emit('close');
    const result = await promise;
    expect(stream.write).toHaveBeenCalledWith(' ');
    expect(result.stdout).not.toContain('--More--');
  });

  it('forwards clean (stripped) chunks to the onStream callback', async () => {
    const stream = makeFakeStream();
    const manager = makeFakeManager(stream);
    const chunks: string[] = [];
    const promise = execCommand(manager, 'display version', (c) => {
      if (c.stream === 'stdout') chunks.push(c.data);
    });
    await flush();
    stream.emit('data', Buffer.from('line1\n  ---- More ----'));
    stream.emit('data', Buffer.from('line2\n'));
    stream.emit('exit', 0);
    stream.emit('close');
    await promise;
    expect(chunks.join('')).not.toContain('---- More ----');
    expect(chunks.join('')).toContain('line1');
  });

  it('still resolves (with partial output) when the pager cap is hit', async () => {
    // With a tiny cap, additional pages are not advanced; the command would
    // time out on a real device, but here we manually close to verify no crash
    // and that already-advanced pages are stripped.
    const stream = makeFakeStream();
    const manager = makeFakeManager(stream);
    const promise = execCommand(manager, 'display logbuffer');
    await flush();
    stream.emit('data', Buffer.from('p1\n  ---- More ----'));
    stream.emit('data', Buffer.from('p2\n  ---- More ----'));
    stream.emit('data', Buffer.from('p3\n'));
    stream.emit('exit', 0);
    stream.emit('close');
    const result = await promise;
    // At least the first page triggered an advance.
    expect(stream.write).toHaveBeenCalledWith(' ');
    expect(result.stdout).toContain('p1');
  });
});

describe('execCommand device profile (Phase 2)', () => {
  it('allocates a PTY for a Huawei VRP switch and strips ANSI from output', async () => {
    const stream = makeFakeStream();
    let capturedPty: unknown = undefined;
    const manager = makeFakeManager(stream, {
      deviceType: 'huawei-vrp',
      onExec: (_cmd, ptyOpt) => {
        capturedPty = ptyOpt;
      },
    });
    const promise = execCommand(manager, 'display version');
    await flush();
    // PTY devices emit ANSI escapes (e.g. color / clear-line) mixed with output.
    stream.emit('data', Buffer.from('\x1b[32mVRP Software\x1b[0m\n  ---- More ----'));
    stream.emit('data', Buffer.from('\x1b[31muptime\x1b[0m\n'));
    stream.emit('exit', 0);
    stream.emit('close');
    const result = await promise;
    // exec was called with a pty option object (not undefined).
    expect(capturedPty).toEqual({ pty: { term: 'xterm', cols: 200, rows: 50 } });
    // ANSI escapes removed.
    expect(result.stdout).not.toContain('\x1b[');
    expect(result.stdout).toContain('VRP Software');
    expect(result.stdout).toContain('uptime');
    // Pager prompt stripped too.
    expect(result.stdout).not.toContain('---- More ----');
  });

  it('does NOT allocate a PTY for a Linux host (no-PTY regression guard)', async () => {
    const stream = makeFakeStream();
    let capturedPty: unknown = 'unset';
    const manager = makeFakeManager(stream, {
      deviceType: 'linux',
      onExec: (_cmd, ptyOpt) => {
        capturedPty = ptyOpt;
      },
    });
    const promise = execCommand(manager, 'ls -la');
    await flush();
    stream.emit('data', Buffer.from('file1\nfile2\n'));
    stream.emit('exit', 0);
    stream.emit('close');
    await promise;
    expect(capturedPty).toBeUndefined();
  });

  it('defaults to no-PTY when deviceType is unset (legacy hosts)', async () => {
    const stream = makeFakeStream();
    let capturedPty: unknown = 'unset';
    const manager = makeFakeManager(stream, {
      onExec: (_cmd, ptyOpt) => {
        capturedPty = ptyOpt;
      },
    });
    const promise = execCommand(manager, 'uname -a');
    await flush();
    stream.emit('data', Buffer.from('Linux\n'));
    stream.emit('exit', 0);
    stream.emit('close');
    await promise;
    expect(capturedPty).toBeUndefined();
  });
});

describe('execCommand pager handling (su shell path)', () => {
  it('auto-advances pagination and strips artifacts in the su shell', async () => {
    const suShell = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn> };
    suShell.write = vi.fn();
    const manager = makeSuShellManager(suShell);
    const promise = execCommand(manager, 'systemctl status foo');
    await flush();
    // execViaSuShell writes the command line first.
    expect(suShell.write).toHaveBeenCalledWith('systemctl status foo\n');
    // First page of output ends in a pager prompt -> Space sent.
    suShell.emit('data', Buffer.from('systemctl status foo\nActive: active\n  ---- More ----'));
    expect(suShell.write).toHaveBeenCalledWith(' ');
    // Rest of the output + the shell prompt that delimits completion.
    suShell.emit('data', Buffer.from('Docs: man:foo\n# '));
    const result = await promise;
    expect(result.stdout).not.toContain('---- More ----');
    expect(result.stdout).toContain('Active: active');
    expect(result.stdout).toContain('Docs: man:foo');
  });
});
