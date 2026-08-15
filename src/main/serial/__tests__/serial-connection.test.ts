// Unit tests for SerialConnectionManager using a scripted fake serial port
// (injected via the port factory - no hardware or serialport import needed).
import { describe, it, expect } from 'vitest';
import {
  SerialConnectionManager,
  type SerialPortLike,
  type SerialPortFactory,
} from '../serial-connection.js';
import type { HostConfig } from '../../../shared/types.js';

// A fake serialport shaped like the subset SerialPortLike needs (cast at the
// factory - structural `implements` fights the event-cb overloads). `script`
// entries are consumed in order: each write is matched against the next
// unconsumed entry; on match the reply is emitted as a data event.
class FakeSerialPort {
  handlers = new Map<string, Array<(arg?: unknown) => void>>();
  written: string[] = [];
  closed = false;
  constructor(
    public options: unknown,
    public script: Array<{ match: RegExp; reply: string }>,
  ) {}
  on(event: string, cb: (arg?: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  write(data: string): boolean {
    this.written.push(data);
    const idx = this.script.findIndex((entry) => entry.match.test(data));
    if (idx >= 0) {
      const entry = this.script.splice(idx, 1)[0];
      setTimeout(() => this.emitData(entry.reply), 5);
    }
    return true;
  }
  close(cb?: (err?: Error | null) => void): void {
    this.closed = true;
    this.emit('close');
    cb?.(null);
  }
  emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers.get(event) ?? []) cb(arg);
  }
  emitData(chunk: string): void {
    this.emit('data', Buffer.from(chunk, 'utf8'));
  }
}

function makeHost(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    id: 'h1',
    name: 'switch-init',
    host: 'COM3',
    port: 22,
    username: 'admin',
    authType: 'password',
    password: 'secret',
    groupName: 'default',
    timeoutMs: 10_000,
    agentForward: false,
    deviceType: 'generic',
    connectionType: 'serial',
    serialPort: 'COM3',
    baudRate: 9600,
    loginRequired: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

function makeManager(
  hostOverrides: Partial<HostConfig> = {},
  script: Array<{ match: RegExp; reply: string }> = [],
  timing: { quietMs?: number; readyTimeoutMs?: number; loginTimeoutMs?: number } = {},
): { mgr: SerialConnectionManager; portRef: { current: FakeSerialPort | null } } {
  // Ref (not a destructured value): the factory assigns it only when
  // connect() runs, after makeManager() has returned.
  const portRef: { current: FakeSerialPort | null } = { current: null };
  const factory: SerialPortFactory = (options) => {
    const port = new FakeSerialPort(options, script);
    portRef.current = port;
    // Real serialport emits 'open' asynchronously after construction.
    setTimeout(() => port.emit('open'), 1);
    return port as unknown as SerialPortLike;
  };
  const mgr = new SerialConnectionManager(makeHost(hostOverrides), {
    createPort: factory,
    quietMs: timing.quietMs ?? 20,
    readyTimeoutMs: timing.readyTimeoutMs ?? 500,
    loginTimeoutMs: timing.loginTimeoutMs ?? 1000,
  });
  return { mgr, portRef };
}

describe('SerialConnectionManager', () => {
  it('connect() opens the port with resolved options', async () => {
    const { mgr, portRef } = makeManager();
    await mgr.connect();
    expect(portRef.current!.options).toMatchObject({ path: 'COM3', baudRate: 9600, dataBits: 8 });
    expect(mgr.isConnected()).toBe(true);
  });

  it('connect() sends a wake newline and waits for a CLI prompt (no login)', async () => {
    const { mgr, portRef } = makeManager({}, [{ match: /\r/, reply: '<Switch>' }]);
    await mgr.connect();
    // Wake newline sent, no credentials sent.
    expect(portRef.current!.written.join('')).toContain('\r');
    expect(portRef.current!.written.join('')).not.toContain('admin');
  });

  it('connect() auto-logs in when loginRequired', async () => {
    const { mgr, portRef } = makeManager({ loginRequired: true }, [
      { match: /admin/, reply: 'Password: ' },
      { match: /secret/, reply: '\r\n<Switch>' },
      // The initial wake newline is answered by the login prompt below via
      // the wake -> prompt flow: the console prints the login banner.
    ]);
    // Simulate the console printing a login prompt shortly after open.
    const p = mgr.connect();
    setTimeout(() => portRef.current!.emitData('Login: '), 5);
    await p;
    // Wake newline + credentials were written; only assert credentials below.
    expect(portRef.current!.written.join('')).toContain('admin\r');
    expect(portRef.current!.written.join('')).toContain('secret\r');
  });

  it('connect() rejects on login failure (bad credentials)', async () => {
    const { mgr, portRef } = makeManager({ loginRequired: true }, [
      { match: /admin/, reply: 'Password: ' },
      { match: /secret/, reply: 'Login failed\r\nLogin: ' },
    ]);
    const p = mgr.connect();
    setTimeout(() => portRef.current!.emitData('Login: '), 5);
    await expect(p).rejects.toThrow(/登录|login/i);
  });

  it('exec() sends the command and collects output until the prompt returns', async () => {
    const { mgr } = makeManager({}, [
      { match: /\r/, reply: '<Switch>' },
      {
        match: /display version/,
        reply: 'Huawei Versatile Routing Platform\r\nVRP (R) Software\r\n<Switch>',
      },
    ]);
    await mgr.connect();
    const result = await mgr.exec('display version');
    expect(result.stdout).toContain('Versatile Routing Platform');
    expect(result.stdout).not.toContain('<Switch>'); // prompt stripped from tail
    expect(result.exitCode).toBeNull();
    expect(result.viaSuShell).toBe(false);
  });

  it('exec() advances the pager when output ends in a More prompt', async () => {
    const { mgr, portRef } = makeManager({}, [
      { match: /\r/, reply: '<Switch>' },
      { match: /display clock/, reply: 'line1\r\n  ---- More ----' },
      { match: / $/, reply: 'line2\r\n<Switch>' },
    ]);
    await mgr.connect();
    const result = await mgr.exec('display clock');
    expect(result.stdout).toContain('line1');
    expect(result.stdout).toContain('line2');
    expect(portRef.current!.written.join('')).toContain(' '); // advance key (Space) sent
  });

  it('exec() resolves with partial output on timeout', async () => {
    const { mgr } = makeManager({}, [
      { match: /\r/, reply: '<Switch>' },
      { match: /long-command/, reply: 'partial output, no prompt' },
    ]);
    await mgr.connect();
    const result = await mgr.exec('long-command', { timeoutMs: 200 });
    expect(result.stdout).toContain('partial output');
  });

  it('exec() resolves with partial output when aborted via signal', async () => {
    const { mgr } = makeManager({}, [
      { match: /\r/, reply: '<Switch>' },
      { match: /long-command/, reply: 'streaming...' },
    ]);
    await mgr.connect();
    const controller = new AbortController();
    const p = mgr.exec('long-command', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await p;
    expect(result.aborted).toBe(true);
    expect(result.stdout).toContain('streaming');
  });

  it('exec() serializes concurrent commands (one console, one command at a time)', async () => {
    const { mgr, portRef } = makeManager({}, [
      { match: /\r/, reply: '<Switch>' },
      { match: /cmd-one/, reply: 'out1\r\n<Switch>' },
      { match: /cmd-two/, reply: 'out2\r\n<Switch>' },
    ]);
    await mgr.connect();
    const [r1, r2] = await Promise.all([mgr.exec('cmd-one'), mgr.exec('cmd-two')]);
    expect(r1.stdout).toContain('out1');
    expect(r2.stdout).toContain('out2');
    // cmd-two was written only after cmd-one completed: no interleaving.
    const writes = portRef.current!.written.join('');
    expect(writes.indexOf('cmd-one')).toBeLessThan(writes.indexOf('cmd-two'));
  });

  it('broadcasts raw output to subscribers (terminal mirror)', async () => {
    const { mgr } = makeManager({}, [
      { match: /\r/, reply: '<Switch>' },
      { match: /display version/, reply: 'hello\r\n<Switch>' },
    ]);
    await mgr.connect();
    const seen: string[] = [];
    const unsubscribe = mgr.subscribe((chunk) => seen.push(chunk));
    await mgr.exec('display version');
    expect(seen.join('')).toContain('hello');
    unsubscribe();
  });

  it('write() passes raw terminal input straight to the port', async () => {
    const { mgr, portRef } = makeManager();
    await mgr.connect();
    mgr.write('sys\r');
    expect(portRef.current!.written).toContain('sys\r');
  });

  it('close() closes the port and disconnects', async () => {
    const { mgr, portRef } = makeManager();
    await mgr.connect();
    mgr.close();
    expect(portRef.current!.closed).toBe(true);
    expect(mgr.isConnected()).toBe(false);
  });
});

describe('SerialConnectionManager timing', () => {
  it('connect() times out when the port never opens', async () => {
    const mgr = new SerialConnectionManager(makeHost(), {
      createPort: (options) =>
        new FakeSerialPort(options, []) as unknown as SerialPortLike, // never opens
      quietMs: 10,
      readyTimeoutMs: 50,
      loginTimeoutMs: 50,
      openTimeoutMs: 80,
    });
    await expect(mgr.connect()).rejects.toThrow(/打开|open/i);
  });
});
