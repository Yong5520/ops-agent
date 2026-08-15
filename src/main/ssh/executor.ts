import { OpsAgentError } from './connection.js';
import type { SSHConnectionManager } from './connection.js';
import { escapeCommandForShell } from '../security/engine.js';
import type { ExecResult, ExecStreamCallback } from './types.js';
import type { ClientChannel } from 'ssh2';
import { createPagerAdvancer, stripPagerArtifacts, stripAnsi, PAGER_ADVANCE_KEY } from './pager.js';
import { getDeviceProfile } from './device-profiles.js';

// Command executor — extracted from ssh-mcp-multi execSshCommand (lines 520-569)
// with the following changes:
//   - McpError replaced by OpsAgentError
//   - Returns structured ExecResult (stdout/stderr/exitCode/duration) instead
//     of MCP content envelope
//   - Accepts an optional onStream callback for chunk-based streaming
//   - sudo-exec wraps the command in `sudo -S sh -c` (or `sudo -n` when no password)
//   - su shell path preserved for hosts with suPassword configured

// Execute a normal command on the host.
//
// `signal` (optional, V3-07 Cycle B): when aborted, the ssh2 stream is closed
// and the promise resolves with the partial output accumulated so far
// (exitCode = null). This lets stop_tail / the UI stop button cancel a
// long-running command (tail -f, slow grep) instead of waiting for the host
// timeout.
export async function execCommand(
  manager: SSHConnectionManager,
  command: string,
  onStream?: ExecStreamCallback,
  signal?: AbortSignal,
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
    // Device profile: network-device CLIs paginate and read the advance key
    // from a terminal, so exec allocates a PTY for them (the pager then
    // receives the Space that createPagerAdvancer sends). Linux/generic hosts
    // keep the no-PTY path. `clean` strips ANSI (PTY only) + pager prompts so
    // the model sees plain, continuous output.
    const profile = getDeviceProfile(manager.deviceType);
    const clean = (text: string): string =>
      stripPagerArtifacts(profile.pty ? stripAnsi(text) : text);
    let isResolved = false;
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let activeStream: { close: () => void } | null = null;

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

    // V3-07 Cycle B: abort handling. On signal abort, close the ssh2 stream so
    // the remote command terminates, then resolve with the partial output. The
    // stream's 'close' handler is a no-op once isResolved is set.
    const onAbort = () => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutId);
      try {
        activeStream?.close();
      } catch {
        // stream already gone - ignore
      }
      resolve({
        stdout: clean(stdout),
        stderr,
        exitCode: null, // aborted - no real exit code
        durationMs: Date.now() - start,
        viaSuShell: false,
        aborted: true,
      });
    };
    if (signal) {
      if (signal.aborted) {
        // Already aborted before exec started - resolve immediately with empty.
        isResolved = true;
        clearTimeout(timeoutId);
        resolve({
          stdout: '',
          stderr: '',
          exitCode: null,
          durationMs: 0,
          viaSuShell: false,
          aborted: true,
        });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const conn = manager.getConnection();
    const onExec = (err: Error | undefined, stream: ClientChannel) => {
      if (err) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          reject(new OpsAgentError(`SSH exec error: ${err.message}`, 'SSH_ERROR'));
        }
        return;
      }

      activeStream = stream as unknown as { close: () => void };

      // Network-device pager handling: when the device emits a `---- More ----`
      // prompt and blocks waiting for a keypress, send Space to advance to the
      // next page so the command completes instead of timing out. Prompt lines
      // (and, in PTY mode, ANSI escapes) are stripped from both the streaming
      // chunks and the final stdout so the model sees clean, continuous output.
      const advancer = createPagerAdvancer({
        onAdvance: () => {
          try {
            stream.write(PAGER_ADVANCE_KEY);
          } catch {
            // stream already closed - ignore
          }
        },
      });

      stream.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        advancer.consumeChunk(chunk);
        onStream?.({ stream: 'stdout', data: clean(chunk) });
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
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve({
            stdout: clean(stdout),
            stderr,
            exitCode,
            durationMs: Date.now() - start,
            viaSuShell: false,
          });
        }
      });
    };
    // Network devices: allocate a PTY so the device's pager reads the Space we
    // send. A wide column count avoids line-wrap artifacts in the captured
    // output. Linux/generic hosts use the plain no-PTY exec channel.
    if (profile.pty) {
      conn.exec(command, { pty: { term: 'xterm', cols: 200, rows: 50 } }, onExec);
    } else {
      conn.exec(command, onExec);
    }
  });
}

// Execute a command with sudo privileges.
export async function sudoExecCommand(
  manager: SSHConnectionManager,
  command: string,
  onStream?: ExecStreamCallback,
  signal?: AbortSignal,
): Promise<ExecResult> {
  await manager.ensureConnected();

  // If su shell is active, the command already runs as root — skip wrapping.
  if (manager.getSuShell()) {
    return execCommand(manager, command, onStream, signal);
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

  return execCommand(manager, wrapped, onStream, signal);
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

    // Pager handling for the su shell path (a command run as root may still
    // paginate, e.g. a tool that ignores --no-pager). Advance with Space and
    // strip the prompt from the returned output.
    const advancer = createPagerAdvancer({
      onAdvance: () => {
        try {
          suShell.write(PAGER_ADVANCE_KEY);
        } catch {
          // shell already closed - ignore
        }
      },
    });

    const dataHandler = (data: Buffer) => {
      const text = data.toString();
      buffer += text;
      advancer.consumeChunk(text);
      // Wait for the shell prompt (ends with #) to signal command completion
      if (/#\s*$/.test(buffer)) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          suShell.removeAllListeners('data');
          // Drop the echoed command line and the trailing prompt
          const lines = buffer.split('\n');
          const output = stripPagerArtifacts(lines.slice(1, -1).join('\n'));
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
