// Unit tests for the unified host command runner. Both pools are mocked so the
// branch on connectionType is verified without real connections.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  sshPool: { get: vi.fn(), invalidate: vi.fn() },
  serialPool: { get: vi.fn(), invalidate: vi.fn() },
  sshExec: vi.fn(),
  sshSudoExec: vi.fn(),
}));

vi.mock('../../ssh/index.js', () => ({
  connectionPool: mocks.sshPool,
  execCommand: mocks.sshExec,
  sudoExecCommand: mocks.sshSudoExec,
}));
vi.mock('../../serial/index.js', () => ({ serialPool: mocks.serialPool }));

import {
  runHostCommand,
  runHostSudoCommand,
  invalidateHostConnection,
  hostCommandSucceeded,
  isSerialHost,
} from '../host-command.js';
import type { HostConfig } from '../../../shared/types.js';

const { sshPool, serialPool, sshExec, sshSudoExec } = mocks;

function sshHost(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    id: 'h1',
    name: 'web-1',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    groupName: 'default',
    timeoutMs: 60000,
    agentForward: false,
    deviceType: 'linux',
    connectionType: 'ssh',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

function serialHost(overrides: Partial<HostConfig> = {}): HostConfig {
  return sshHost({
    id: 's1',
    name: 'switch-init',
    host: 'COM3',
    connectionType: 'serial',
    serialPort: 'COM3',
    baudRate: 9600,
    deviceType: 'generic',
    ...overrides,
  });
}

beforeEach(() => {
  sshPool.get.mockReset();
  sshPool.invalidate.mockReset();
  serialPool.get.mockReset();
  serialPool.invalidate.mockReset();
  sshExec.mockReset();
  sshSudoExec.mockReset();
});

describe('isSerialHost', () => {
  it('true for serial hosts', () => {
    expect(isSerialHost(serialHost())).toBe(true);
  });
  it('false for ssh hosts', () => {
    expect(isSerialHost(sshHost())).toBe(false);
  });
});

describe('runHostCommand', () => {
  it('uses the SSH pool + execCommand for ssh hosts', async () => {
    const manager = { id: 'mgr' };
    sshPool.get.mockResolvedValue(manager);
    sshExec.mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
      viaSuShell: false,
    });
    const result = await runHostCommand(sshHost(), 'ls');
    expect(sshPool.get).toHaveBeenCalledWith('h1');
    expect(serialPool.get).not.toHaveBeenCalled();
    expect(sshExec).toHaveBeenCalledWith(manager, 'ls', undefined, undefined);
    expect(result.exitCode).toBe(0);
  });

  it('uses the serial pool + manager.exec for serial hosts', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: 'vrp',
      stderr: '',
      exitCode: null,
      durationMs: 9,
      viaSuShell: false,
    });
    serialPool.get.mockResolvedValue({ exec });
    const result = await runHostCommand(serialHost(), 'display version');
    expect(serialPool.get).toHaveBeenCalledWith('s1');
    expect(sshPool.get).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith('display version', {
      onStream: undefined,
      signal: undefined,
    });
    expect(result.stdout).toBe('vrp');
  });

  it('passes onStream + signal through on both paths', async () => {
    const onStream = () => undefined;
    const signal = new AbortController().signal;
    sshPool.get.mockResolvedValue({});
    sshExec.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      viaSuShell: false,
    });
    await runHostCommand(sshHost(), 'ls', onStream, signal);
    // The runner stamps the pooled manager with a mirrorSessionId for the v24
    // activity mirror, so match by shape rather than a fresh empty object.
    expect(sshExec).toHaveBeenCalledWith(
      expect.objectContaining({ mirrorSessionId: '' }),
      'ls',
      onStream,
      signal,
    );
  });
});

describe('runHostSudoCommand', () => {
  it('uses sudoExecCommand for ssh hosts', async () => {
    const manager = {};
    sshPool.get.mockResolvedValue(manager);
    sshSudoExec.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      viaSuShell: true,
    });
    await runHostSudoCommand(sshHost(), 'sudo ls');
    expect(sshSudoExec).toHaveBeenCalledWith(manager, 'sudo ls', undefined, undefined);
  });

  it('runs the command directly (no sudo layer) for serial hosts', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: null,
      durationMs: 0,
      viaSuShell: false,
    });
    serialPool.get.mockResolvedValue({ exec });
    await runHostSudoCommand(serialHost(), 'reboot');
    expect(exec).toHaveBeenCalledWith('reboot', { onStream: undefined, signal: undefined });
  });
});

describe('invalidateHostConnection', () => {
  it('invalidates the ssh pool for ssh hosts', () => {
    invalidateHostConnection(sshHost());
    expect(sshPool.invalidate).toHaveBeenCalledWith('h1');
    expect(serialPool.invalidate).not.toHaveBeenCalled();
  });
  it('invalidates the serial pool for serial hosts', () => {
    invalidateHostConnection(serialHost());
    expect(serialPool.invalidate).toHaveBeenCalledWith('s1');
  });
});

describe('hostCommandSucceeded', () => {
  it('ssh: exit code 0', () => {
    expect(
      hostCommandSucceeded(sshHost(), {
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 0,
        viaSuShell: false,
      }),
    ).toBe(true);
    expect(
      hostCommandSucceeded(sshHost(), {
        stdout: '',
        stderr: '',
        exitCode: 1,
        durationMs: 0,
        viaSuShell: false,
      }),
    ).toBe(false);
  });
  it('serial: not aborted and no stderr', () => {
    expect(
      hostCommandSucceeded(serialHost(), {
        stdout: 'x',
        stderr: '',
        exitCode: null,
        durationMs: 0,
        viaSuShell: false,
      }),
    ).toBe(true);
    expect(
      hostCommandSucceeded(serialHost(), {
        stdout: 'x',
        stderr: 'timeout',
        exitCode: null,
        durationMs: 0,
        viaSuShell: false,
      }),
    ).toBe(false);
    expect(
      hostCommandSucceeded(serialHost(), {
        stdout: 'x',
        stderr: '',
        exitCode: null,
        durationMs: 0,
        viaSuShell: false,
        aborted: true,
      }),
    ).toBe(false);
  });
});
