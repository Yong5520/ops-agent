import { OpsAgentError } from './connection.js';
import type { SSHConnectionManager } from './connection.js';
import { escapeCommandForShell } from '../security/engine.js';
import type { ExecResult, ExecStreamCallback } from './types.js';

// Command executor — extracted from ssh-mcp-multi execSshCommand (lines 520-569)
// with the following changes:
//   - McpError replaced by OpsAgentError
//   - Returns structured ExecResult (stdout/stderr/exitCode/duration) instead
//     of MCP content envelope
//   - Accepts an optional onStream callback for chunk-based streaming
//   - sudo-exec wraps the command in `sudo -S sh -c` (or `sudo -n` when no password)
//   - su shell path preserved for hosts with suPassword configured

// Execute a normal command on the host.
export async function execCommand(
  manager: SSHConnectionManager,
  command: string,
  onStream?: ExecStreamCallback,
): Promise<ExecResult> {
  await manager.ensureConnected();
  const start = Date.now();

  // If a persistent su shell is active, route the command through it.
  const suShell = manager.getSuShell();
  if (suShell) {
    return execViaSuShell(manager, command, suShell, start);
  }

  return new Promise<ExecResult>((resolve, reject) => {
    const timeout = manager.timeout;
    let isResolved = false;
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;

    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        reject(
          new OpsAgentError(
            `[${manager.hostName}] Command timed out after ${timeout}ms`,
            'SSH_TIMEOUT',
          ),
        );
      }
    }, timeout);

    const conn = manager.getConnection();
    conn.exec(command, (err, stream) => {
      if (err) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          reject(new OpsAgentError(`SSH exec error: ${err.message}`, 'SSH_ERROR'));
        }
        return;
      }

      stream.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        onStream?.({ stream: 'stdout', data: chunk });
      });
      stream.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        onStream?.({ stream: 'stderr', data: chunk });
      });
      stream.on('exit', (code: number | null) => {
        exitCode = code;
      });
      stream.on('close', () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          resolve({
            stdout,
            stderr,
            exitCode,
            durationMs: Date.now() - start,
            viaSuShell: false,
          });
        }
      });
    });
  });
}

// Execute a command with sudo privileges.
export async function sudoExecCommand(
  manager: SSHConnectionManager,
  command: string,
  onStream?: ExecStreamCallback,
): Promise<ExecResult> {
  await manager.ensureConnected();

  // If su shell is active, the command already runs as root — skip wrapping.
  if (manager.getSuShell()) {
    return execCommand(manager, command, onStream);
  }

  const sudoPassword = manager.sudoPassword;
  // Defense-in-depth: strip leading 'sudo ' prefix from the command if the
  // model already included it. This tool wraps commands in `sudo -S sh -c`,
  // so a double `sudo` causes password authentication to fail.
  // Example: "sudo apt update" -> "apt update"
  const cleanedCommand = command.replace(/^\s*sudo\s+/, '');
  const escapedCmd = escapeCommandForShell(cleanedCommand);
  let wrapped: string;
  if (!sudoPassword) {
    // Passwordless sudo
    wrapped = `sudo -n sh -c '${escapedCmd}'`;
  } else {
    const pwdEscaped = sudoPassword.replace(/'/g, "'\\''");
    wrapped = `printf '%s\\n' '${pwdEscaped}' | sudo -p "" -S sh -c '${escapedCmd}'`;
  }

  return execCommand(manager, wrapped, onStream);
}

// Execute a command via the persistent su shell.
// Output parsing mirrors the original ssh-mcp-multi logic: wait for a `#`
// prompt to delimit command output, then return the lines between.
function execViaSuShell(
  manager: SSHConnectionManager,
  command: string,
  suShell: NonNullable<ReturnType<SSHConnectionManager['getSuShell']>>,
  start: number,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let isResolved = false;
    let buffer = '';
    const timeout = manager.timeout;
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        suShell.removeAllListeners('data');
        reject(
          new OpsAgentError(
            `[${manager.hostName}] su shell command timed out after ${timeout}ms`,
            'SSH_TIMEOUT',
          ),
        );
      }
    }, timeout);

    const dataHandler = (data: Buffer) => {
      buffer += data.toString();
      // Wait for the shell prompt (ends with #) to signal command completion
      if (/#\s*$/.test(buffer)) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          suShell.removeAllListeners('data');
          // Drop the echoed command line and the trailing prompt
          const lines = buffer.split('\n');
          const output = lines.slice(1, -1).join('\n');
          resolve({
            stdout: output,
            stderr: '',
            exitCode: 0,
            durationMs: Date.now() - start,
            viaSuShell: true,
          });
        }
      }
    };

    suShell.on('data', dataHandler);
    suShell.write(command + '\n');
  });
}
