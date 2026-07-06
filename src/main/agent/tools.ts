import { z } from 'zod';
import { tool } from 'ai';
import { connectionPool, execCommand, sudoExecCommand, readFile, writeFile } from '../ssh/index.js';
import { hostsStore } from '../storage/hosts.js';
import { auditStore } from '../storage/audit.js';
import { getEffectiveConfig, checkCommandSecurity, sanitizeCommand } from '../security/index.js';
import { decideByMode } from '../security/modes.js';
import { logger } from '../utils/logger.js';
import type { SafetyMode, HostConfig } from '../../shared/types.js';
import type {
  SessionContext,
  ToolCallInfo,
  ToolCallResult,
  AuthorizationRequest,
  AuthorizationResponse,
  ToolExecutionRecord,
} from './types.js';

// Tool factory — creates the tools object for a single agent loop invocation.
// Tools close over the session context and streaming callbacks so they can:
//   1. Run security checks (M4)
//   2. Apply safety mode decisions (M4-04)
//   3. Request user authorization when needed (M5-07)
//   4. Execute via SSH layer (M3)
//   5. Record audit logs (M5-08)
//   6. Stream results back to UI

export interface ToolFactoryDeps {
  context: SessionContext;
  safetyMode: SafetyMode;
  onToolCall: (info: ToolCallInfo) => void;
  onToolResult: (result: ToolCallResult) => void;
  onAuthorizationRequired: (request: AuthorizationRequest) => Promise<AuthorizationResponse>;
}

export function createTools(deps: ToolFactoryDeps) {
  const { context, safetyMode, onToolCall, onToolResult, onAuthorizationRequired } = deps;
  const securityConfig = getEffectiveConfig(safetyMode);

  // ── Host resolution helper ──────────────────────────────────────────────
  // Resolve a host name (from AI tool call) to a HostConfig. Falls back to
  // the session's default host (first selected) if the AI didn't specify one.
  // The host must be in the session's selected allow-list, otherwise the call
  // is rejected — this prevents the AI from touching hosts the user didn't
  // select for this session.
  function resolveHost(hostName?: string): { host: HostConfig; name: string } {
    const name = hostName ?? context.defaultHost?.name ?? context.hostName;
    const host = hostsStore.getByName(name);
    if (!host) {
      throw new Error(
        `Unknown host "${name}". Available: ${hostsStore
          .list()
          .map((h) => h.name)
          .join(', ')}`,
      );
    }
    if (!context.hostIds.includes(host.id)) {
      const allowedNames = context.hostIds.map((id) => hostsStore.get(id)?.name ?? id).join(', ');
      throw new Error(
        `Host "${name}" is not selected for this session. Selected hosts: ${allowedNames || '(none)'}`,
      );
    }
    return { host, name };
  }

  // ── Pre-execution pipeline ──────────────────────────────────────────────
  // Runs security check + mode decision + authorization. Returns either
  // { proceed: true } or { proceed: false, reason } to short-circuit.
  async function preExec(
    toolCallId: string,
    toolName: string,
    command: string,
    host: HostConfig,
    description?: string,
  ): Promise<{
    proceed: boolean;
    reason?: string;
    commandType: 'READ' | 'WRITE' | 'SUDO' | 'BLOCKED';
    authorization: 'auto' | 'approved' | 'rejected' | 'blocked';
  }> {
    // 1. Security rule check (always applies, all modes)
    const secResult = checkCommandSecurity(command, host.id, securityConfig);
    if (!secResult.allowed) {
      onToolCall({
        toolCallId,
        toolName,
        hostId: host.id,
        hostName: host.name,
        command,
        description,
        commandType: 'BLOCKED',
        needsApproval: false,
      });
      onToolResult({
        toolCallId,
        toolName,
        success: false,
        blockedReason: secResult.reason,
        authorization: 'blocked',
      });
      return {
        proceed: false,
        reason: secResult.reason,
        commandType: 'BLOCKED',
        authorization: 'blocked',
      };
    }

    const commandType = secResult.commandType;

    // 2. Mode decision
    const decision = decideByMode(safetyMode, commandType);
    if (!decision.allowed) {
      onToolCall({
        toolCallId,
        toolName,
        hostId: host.id,
        hostName: host.name,
        command,
        description,
        commandType,
        needsApproval: false,
      });
      onToolResult({
        toolCallId,
        toolName,
        success: false,
        blockedReason: decision.reason,
        authorization: 'blocked',
      });
      return { proceed: false, reason: decision.reason, commandType, authorization: 'blocked' };
    }

    // 3. Authorization (if needed)
    if (decision.needsApproval) {
      onToolCall({
        toolCallId,
        toolName,
        hostId: host.id,
        hostName: host.name,
        command,
        description,
        commandType,
        needsApproval: true,
      });
      const request: AuthorizationRequest = {
        toolCallId,
        toolName,
        hostName: host.name,
        hostIp: host.host,
        command,
        description,
        commandType,
        safetyMode,
      };
      const response = await onAuthorizationRequired(request);
      if (!response.approved) {
        onToolResult({
          toolCallId,
          toolName,
          success: false,
          blockedReason: response.reason ?? 'User rejected',
          authorization: 'rejected',
        });
        return {
          proceed: false,
          reason: response.reason ?? 'User rejected',
          commandType,
          authorization: 'rejected',
        };
      }
      return { proceed: true, commandType, authorization: 'approved' };
    }

    // Auto-approved (READ in any mode, or anything in autopilot)
    onToolCall({
      toolCallId,
      toolName,
      hostId: host.id,
      hostName: host.name,
      command,
      description,
      commandType,
      needsApproval: false,
    });
    return { proceed: true, commandType, authorization: 'auto' };
  }

  // ── Audit logging helper ────────────────────────────────────────────────
  function recordAudit(rec: ToolExecutionRecord): void {
    try {
      auditStore.create({
        sessionId: rec.sessionId,
        hostId: rec.hostId,
        hostName: rec.hostName,
        hostIp: rec.hostIp,
        safetyMode,
        commandType: rec.commandType,
        command: rec.command,
        description: rec.description,
        authorization: rec.authorization,
        exitCode: rec.exitCode,
        durationMs: rec.durationMs,
        outputSummary: rec.outputSummary,
      });
    } catch (err) {
      logger.error('Failed to write audit log:', err);
    }
  }

  // ── Tool definitions ────────────────────────────────────────────────────
  return {
    exec: tool({
      description: 'Execute a shell command on a remote SSH server.',
      parameters: z.object({
        host: z
          .string()
          .optional()
          .describe('Target host name. If omitted, uses the session default.'),
        command: z.string().describe('Shell command to execute'),
        description: z
          .string()
          .describe('Purpose of this command — explain WHY you are running it'),
      }),
      execute: async ({ host: hostName, command, description }) => {
        const toolCallId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { host } = resolveHost(hostName);
        const sanitized = sanitizeCommand(command);

        const pre = await preExec(toolCallId, 'exec', sanitized, host, description);
        if (!pre.proceed) {
          recordAudit({
            sessionId: context.sessionId,
            hostId: host.id,
            hostName: host.name,
            hostIp: host.host,
            toolName: 'exec',
            command: sanitized,
            description,
            commandType: pre.commandType,
            authorization: pre.authorization,
            blockedReason: pre.reason,
          });
          return { error: pre.reason, blocked: true };
        }

        try {
          const manager = await connectionPool.get(host.id);
          const result = await execCommand(manager, sanitized);
          const success = result.exitCode === 0;

          onToolResult({
            toolCallId,
            toolName: 'exec',
            success,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            authorization: pre.authorization,
          });

          recordAudit({
            sessionId: context.sessionId,
            hostId: host.id,
            hostName: host.name,
            hostIp: host.host,
            toolName: 'exec',
            command: sanitized,
            description,
            commandType: pre.commandType,
            authorization: pre.authorization,
            exitCode: result.exitCode ?? undefined,
            durationMs: result.durationMs,
            outputSummary: truncateOutput(result.stdout || result.stderr),
          });

          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          };
        } catch (err) {
          const errMsg = formatSshError(err as Error, host.name);
          onToolResult({
            toolCallId,
            toolName: 'exec',
            success: false,
            stderr: errMsg,
            authorization: pre.authorization,
          });
          recordAudit({
            sessionId: context.sessionId,
            hostId: host.id,
            hostName: host.name,
            hostIp: host.host,
            toolName: 'exec',
            command: sanitized,
            description,
            commandType: pre.commandType,
            authorization: pre.authorization,
            exitCode: -1,
            blockedReason: errMsg,
          });
          return { error: errMsg, blocked: false };
        }
      },
    }),

    sudo_exec: tool({
      description: 'Execute a command with sudo privileges on a remote SSH server.',
      parameters: z.object({
        host: z.string().optional().describe('Target host name'),
        command: z.string().describe('Shell command to execute with sudo'),
        description: z.string().describe('Purpose of this command'),
      }),
      execute: async ({ host: hostName, command, description }) => {
        const toolCallId = `sudo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { host } = resolveHost(hostName);
        const sanitized = sanitizeCommand(command);

        const pre = await preExec(toolCallId, 'sudo_exec', sanitized, host, description);
        if (!pre.proceed) {
          recordAudit({
            sessionId: context.sessionId,
            hostId: host.id,
            hostName: host.name,
            hostIp: host.host,
            toolName: 'sudo_exec',
            command: sanitized,
            description,
            commandType: pre.commandType,
            authorization: pre.authorization,
            blockedReason: pre.reason,
          });
          return { error: pre.reason, blocked: true };
        }

        const manager = await connectionPool.get(host.id);
        const result = await sudoExecCommand(manager, sanitized);
        const success = result.exitCode === 0;

        onToolResult({
          toolCallId,
          toolName: 'sudo_exec',
          success,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          authorization: pre.authorization,
        });

        recordAudit({
          sessionId: context.sessionId,
          hostId: host.id,
          hostName: host.name,
          hostIp: host.host,
          toolName: 'sudo_exec',
          command: sanitized,
          description,
          commandType: 'SUDO',
          authorization: pre.authorization,
          exitCode: result.exitCode ?? undefined,
          durationMs: result.durationMs,
          outputSummary: truncateOutput(result.stdout || result.stderr),
        });

        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        };
      },
    }),

    read_file: tool({
      description: 'Read a file on a remote host via SFTP.',
      parameters: z.object({
        host: z.string().optional().describe('Target host name'),
        path: z.string().describe('Remote file path to read'),
        offset: z.number().optional().describe('Start line (1-based)'),
        limit: z.number().optional().describe('Max lines to read (default 1000)'),
      }),
      execute: async ({ host: hostName, path, offset, limit }) => {
        const toolCallId = `read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { host } = resolveHost(hostName);

        // read_file is always READ — no authorization needed, but still
        // notify UI for visibility.
        onToolCall({
          toolCallId,
          toolName: 'read_file',
          hostId: host.id,
          hostName: host.name,
          command: `read_file ${path}`,
          description: `Read ${path}`,
          commandType: 'READ',
          needsApproval: false,
        });

        try {
          const manager = await connectionPool.get(host.id);
          const result = await readFile(manager, path, { offset, limit });
          onToolResult({
            toolCallId,
            toolName: 'read_file',
            success: true,
            stdout: result.content,
            authorization: 'auto',
          });
          recordAudit({
            sessionId: context.sessionId,
            hostId: host.id,
            hostName: host.name,
            hostIp: host.host,
            toolName: 'read_file',
            command: `read_file ${path}`,
            description: `Read ${path}`,
            commandType: 'READ',
            authorization: 'auto',
            exitCode: 0,
            outputSummary: truncateOutput(result.content),
          });
          return {
            content: result.content,
            encoding: result.encoding,
            truncated: result.truncated,
            totalLines: result.totalLines,
          };
        } catch (err) {
          onToolResult({
            toolCallId,
            toolName: 'read_file',
            success: false,
            stderr: (err as Error).message,
            authorization: 'auto',
          });
          return { error: (err as Error).message };
        }
      },
    }),

    write_file: tool({
      description: 'Write content to a file on a remote host via SFTP.',
      parameters: z.object({
        host: z.string().optional().describe('Target host name'),
        path: z.string().describe('Remote file path to write'),
        content: z.string().describe('Content to write'),
        description: z.string().optional().describe('Purpose of this write'),
      }),
      execute: async ({ host: hostName, path, content, description }) => {
        const toolCallId = `write-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { host } = resolveHost(hostName);

        // write_file is always WRITE — goes through normal authorization flow
        const pre = await preExec(
          toolCallId,
          'write_file',
          `write_file ${path}`,
          host,
          description ?? `Write to ${path}`,
        );
        if (!pre.proceed) {
          recordAudit({
            sessionId: context.sessionId,
            hostId: host.id,
            hostName: host.name,
            hostIp: host.host,
            toolName: 'write_file',
            command: `write_file ${path}`,
            description,
            commandType: pre.commandType,
            authorization: pre.authorization,
            blockedReason: pre.reason,
          });
          return { error: pre.reason, blocked: true };
        }

        try {
          const manager = await connectionPool.get(host.id);
          const result = await writeFile(manager, path, content);
          onToolResult({
            toolCallId,
            toolName: 'write_file',
            success: true,
            stdout: `Wrote ${result.bytesWritten} bytes to ${path}`,
            authorization: pre.authorization,
          });
          recordAudit({
            sessionId: context.sessionId,
            hostId: host.id,
            hostName: host.name,
            hostIp: host.host,
            toolName: 'write_file',
            command: `write_file ${path}`,
            description,
            commandType: 'WRITE',
            authorization: pre.authorization,
            exitCode: 0,
            outputSummary: `Wrote ${result.bytesWritten} bytes`,
          });
          return { bytesWritten: result.bytesWritten, path: result.remotePath };
        } catch (err) {
          onToolResult({
            toolCallId,
            toolName: 'write_file',
            success: false,
            stderr: (err as Error).message,
            authorization: pre.authorization,
          });
          return { error: (err as Error).message };
        }
      },
    }),

    list_hosts: tool({
      description: 'List all configured SSH hosts and their connection status.',
      parameters: z.object({}),
      execute: async () => {
        const hosts = hostsStore.list();
        const status = connectionPool.listStatus();
        const statusMap = new Map(status.map((s) => [s.hostId, s.state]));
        const selectedSet = new Set(context.hostIds);
        return {
          hosts: hosts.map((h) => ({
            name: h.name,
            host: h.host,
            port: h.port,
            username: h.username,
            group: h.groupName,
            state: statusMap.get(h.id) ?? 'disconnected',
            selected: selectedSet.has(h.id),
          })),
          currentHost: context.hostName,
        };
      },
    }),
  };
}

// Truncate output for audit log storage (keep full output in tool_calls
// table if needed later; audit_logs stores only summary).
function truncateOutput(text: string, maxChars = 2000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... [truncated, ${text.length - maxChars} more chars]`;
}

// Format SSH/execution errors into user-friendly messages.
function formatSshError(err: Error, hostName: string): string {
  const msg = err.message;
  // Common SSH error patterns
  if (msg.includes('connection timeout') || msg.includes('SSH connection timeout')) {
    return `连接主机 ${hostName} 超时。请检查网络连通性和主机是否在线。`;
  }
  if (msg.includes('All configured authentication methods failed') || msg.includes('SSH error')) {
    return `主机 ${hostName} 认证失败。请检查用户名/密码/密钥配置。`;
  }
  if (msg.includes('ECONNREFUSED')) {
    return `主机 ${hostName} 拒绝连接。请检查 SSH 服务是否运行和端口是否正确。`;
  }
  if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
    return `无法解析主机 ${hostName} 的地址。请检查主机名或 IP 是否正确。`;
  }
  if (msg.includes('Command timed out')) {
    return `命令执行超时。可能是命令等待输入或执行时间过长。`;
  }
  if (msg.includes('Unknown host')) {
    return `未知主机。请检查主机配置或使用 list_hosts 查看可用主机。`;
  }
  return `执行失败: ${msg}`;
}
