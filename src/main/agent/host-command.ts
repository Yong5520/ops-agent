// Unified host command runner - branches on the host's connectionType so the
// agent tools (exec / sudo_exec / exec_multi / read-ops) work over both SSH and
// serial console connections without each tool site knowing the difference.
//
// SSH path: connectionPool + execCommand/sudoExecCommand (unchanged).
// Serial path: serialPool + SerialConnectionManager.exec (expect-style console
// execution - send command, collect output until the prompt returns). Serial
// consoles have no exit code, so callers use hostCommandSucceeded() instead of
// `exitCode === 0`.
//
// v24 activity mirror: every run through this module records a command
// boundary event before execution and a final event after, and stamps the
// manager with the session id so the executor's raw-chunk tap can scope
// events. This gives the mirror terminal command+output framing on both
// transports with one code path.

import { connectionPool, execCommand, sudoExecCommand } from '../ssh/index.js';
import type { SSHConnectionManager } from '../ssh/connection.js';
import { serialPool } from '../serial/index.js';
import type { SerialConnectionManager } from '../serial/serial-connection.js';
import { activityMirrorRecord, MULTI_HOST_BUCKET } from './activity-mirror.js';
import type { HostConfig } from '../../shared/types.js';
import type { ExecResult, ExecStreamCallback } from '../ssh/types.js';

export function isSerialHost(host: HostConfig): boolean {
  return host.connectionType === 'serial';
}

/**
 * Run a command on a host over whichever transport it uses, mirroring
 * command/raw-output/final events into the activity mirror.
 *
 * @param sessionId agent session the command belongs to (mirror scoping)
 * @param toolName  tool name for the mirror header (exec / sudo_exec / ...)
 */
export async function runHostCommand(
  host: HostConfig,
  command: string,
  onStream?: ExecStreamCallback,
  signal?: AbortSignal,
  sessionId = '',
  toolName = 'exec',
): Promise<ExecResult> {
  return runWithMirror(host, command, sessionId, toolName, {
    ssh: (mgr) => execCommand(mgr, command, onStream, signal),
    serial: (mgr) => mgr.exec(command, { onStream, signal }),
  });
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
  sessionId = '',
): Promise<ExecResult> {
  return runWithMirror(host, command, sessionId, 'sudo_exec', {
    ssh: (mgr) => sudoExecCommand(mgr, command, onStream, signal),
    serial: (mgr) => mgr.exec(command, { onStream, signal }),
  });
}

/** Mirror framing + transport dispatch wrapper shared by exec and sudo paths. */
async function runWithMirror(
  host: HostConfig,
  command: string,
  sessionId: string,
  toolName: string,
  opts: {
    ssh: (manager: SSHConnectionManager) => Promise<ExecResult>;
    serial: (manager: SerialConnectionManager) => Promise<ExecResult>;
  },
): Promise<ExecResult> {
  activityMirrorRecord({
    kind: 'command',
    sessionId,
    hostId: host.id,
    hostName: host.name,
    toolName,
    command,
    commandType: 'READ',
  });
  const started = Date.now();
  try {
    // Branch on transport so each manager is statically typed (no casts) and
    // the session stamp lands before the exec taps raw chunks for the mirror.
    let result: ExecResult;
    if (isSerialHost(host)) {
      const mgr = await serialPool.get(host.id);
      stampMirrorSession(mgr, sessionId);
      result = await opts.serial(mgr);
    } else {
      const mgr = await connectionPool.get(host.id);
      stampMirrorSession(mgr, sessionId);
      result = await opts.ssh(mgr);
    }
    activityMirrorRecord({
      kind: 'final',
      sessionId,
      hostId: host.id,
      success: hostCommandSucceeded(host, result),
      exitCode: result.exitCode,
      durationMs: result.durationMs ?? Date.now() - started,
    });
    return result;
  } catch (err) {
    activityMirrorRecord({
      kind: 'final',
      sessionId,
      hostId: host.id,
      success: false,
      exitCode: null,
      stderr: (err as Error).message,
    });
    throw err;
  }
}

function stampMirrorSession(manager: unknown, sessionId: string): void {
  if (manager && typeof manager === 'object') {
    (manager as { mirrorSessionId?: string }).mirrorSessionId = sessionId;
  }
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

// Re-exported for callers that need the multi-host aggregate bucket.
export { MULTI_HOST_BUCKET };
