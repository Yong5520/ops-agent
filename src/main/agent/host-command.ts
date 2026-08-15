// Unified host command runner - branches on the host's connectionType so the
// agent tools (exec / sudo_exec / exec_multi / read-ops) work over both SSH and
// serial console connections without each tool site knowing the difference.
//
// SSH path: connectionPool + execCommand/sudoExecCommand (unchanged).
// Serial path: serialPool + SerialConnectionManager.exec (expect-style console
// execution - send command, collect output until the prompt returns). Serial
// consoles have no exit code, so callers use hostCommandSucceeded() instead of
// `exitCode === 0`.

import { connectionPool, execCommand, sudoExecCommand } from '../ssh/index.js';
import { serialPool } from '../serial/index.js';
import type { HostConfig } from '../../shared/types.js';
import type { ExecResult, ExecStreamCallback } from '../ssh/types.js';

export function isSerialHost(host: HostConfig): boolean {
  return host.connectionType === 'serial';
}

/** Run a command on a host over whichever transport it uses. */
export async function runHostCommand(
  host: HostConfig,
  command: string,
  onStream?: ExecStreamCallback,
  signal?: AbortSignal,
): Promise<ExecResult> {
  if (isSerialHost(host)) {
    const mgr = await serialPool.get(host.id);
    return mgr.exec(command, { onStream, signal });
  }
  const manager = await connectionPool.get(host.id);
  return execCommand(manager, command, onStream, signal);
}

/**
 * Run a sudo/elevated command. On a serial network device there is no
 * sudo/su layer, so the command runs directly (the classifier still gates
 * WRITE/SUDO commands behind approval for safety).
 */
export async function runHostSudoCommand(
  host: HostConfig,
  command: string,
  onStream?: ExecStreamCallback,
  signal?: AbortSignal,
): Promise<ExecResult> {
  if (isSerialHost(host)) {
    const mgr = await serialPool.get(host.id);
    return mgr.exec(command, { onStream, signal });
  }
  const manager = await connectionPool.get(host.id);
  return sudoExecCommand(manager, command, onStream, signal);
}

/** Invalidate the host's connection after a connection-level error so the next
 * call reconnects cleanly. Works for both SSH and serial. */
export function invalidateHostConnection(host: HostConfig): void {
  if (isSerialHost(host)) {
    serialPool.invalidate(host.id);
  } else {
    connectionPool.invalidate(host.id);
  }
}

/**
 * Did the command succeed? SSH uses the exit code; serial consoles have none,
 * so success = not aborted AND no error captured on stderr (a timeout with no
 * output is surfaced as stderr by the serial manager).
 */
export function hostCommandSucceeded(host: HostConfig, result: ExecResult): boolean {
  if (isSerialHost(host)) {
    return !result.aborted && !result.stderr;
  }
  return result.exitCode === 0;
}
