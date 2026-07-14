import { z } from 'zod';
import { tool } from 'ai';
import { connectionPool, execCommand, sudoExecCommand, readFile, writeFile } from '../ssh/index.js';
import { hostsStore } from '../storage/hosts.js';
import { auditStore } from '../storage/audit.js';
import { hooksStore } from '../storage/hooks.js';
import { getEffectiveConfig, checkCommandSecurity, sanitizeCommand } from '../security/index.js';
import { decideByMode } from '../security/modes.js';
import { logger } from '../utils/logger.js';
import type { SafetyMode, HostConfig, TodoItem, Hook } from '../../shared/types.js';
import type {
  SessionContext,
  ToolCallInfo,
  ToolCallResult,
  AuthorizationRequest,
  AuthorizationResponse,
  ToolExecutionRecord,
} from './types.js';
import { createTodoWriteTool } from './tools/todo-write.js';
import { createUpdateMemoryTool } from './tools/update-memory.js';
import { installSkill, getSkillContent, listAllSkills } from './skills/index.js';
import {
  createExitPlanModeTool,
  type ModeHolder,
  type PlanApprovalResult,
  type ModeChangeCallback,
} from './tools/exit-plan-mode.js';
import { createAskUserTool, type AskUserCallback } from './tools/ask-user.js';
import {
  executePreToolUseHooks,
  executePostToolUseHooks,
  defaultExecutor,
} from './hooks/engine.js';
import { createConcurrencyGuard, type ReleaseFunction } from './concurrency.js';
import { shouldPersist, persistToolResult, readPersistedResult } from './tool-results.js';
import {
  buildTailLogCommand,
  buildSearchLogsCommand,
  buildJournalQueryCommand,
  buildProcessListCommand,
  buildServiceStatusCommand,
  buildDiskAnalysisCommand,
  buildNetworkConnectionsCommand,
} from './ops-commands.js';

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
  onTodosUpdate?: (todos: TodoItem[]) => void;
  onPlanApproval?: (plan: string) => Promise<PlanApprovalResult>;
  onModeChange?: ModeChangeCallback;
  // AskUserQuestion (P1-4): lets the model ask the user clarifying questions.
  onAskUser?: AskUserCallback;
  modeHolder: ModeHolder;
}

export function createTools(deps: ToolFactoryDeps) {
  const {
    context,
    safetyMode,
    onToolCall,
    onToolResult,
    onAuthorizationRequired,
    onTodosUpdate,
    onPlanApproval,
    onModeChange,
    onAskUser,
    modeHolder,
  } = deps;
  const securityConfig = getEffectiveConfig(safetyMode);

  // Load enabled hooks once per agent loop invocation. Hooks are evaluated
  // fresh each time tools are created, so config changes take effect on the
  // next user message without restarting the session.
  const enabledHooks: Hook[] = hooksStore.listEnabled();

  // Concurrency guard (P1-1): READ tools share a counting semaphore (max 5),
  // WRITE/SUDO tools use a per-host mutex. Guards are acquired inside each
  // tool's execute() after preExec (security/auth), so we don't hold the
  // lock while waiting for user authorization.
  const guard = createConcurrencyGuard(5);

  // TodoWrite tool (P0-1): task list management, closured over sessionId
  const todoWriteTool = createTodoWriteTool(context.sessionId, onTodosUpdate);

  // update_memory tool (P0-4): persistent agent memory
  const updateMemoryTool = createUpdateMemoryTool();

  // ExitPlanMode tool (P0-1.B): plan approval, only available in plan mode
  const exitPlanModeTool = onPlanApproval
    ? createExitPlanModeTool(context.sessionId, onPlanApproval, modeHolder, onModeChange)
    : undefined;

  // AskUserQuestion tool (P1-4): lets the model ask clarifying questions
  const askUserTool = onAskUser ? createAskUserTool(onAskUser) : undefined;

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
    backupPaths?: string[],
  ): Promise<{
    proceed: boolean;
    reason?: string;
    commandType: 'READ' | 'WRITE' | 'SUDO' | 'BLOCKED';
    authorization: 'auto' | 'approved' | 'rejected' | 'blocked';
    backup?: boolean;
    modifiedCommand?: string;
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

    // 2. PreToolUse hooks - run between security check and mode decision.
    //    deny  -> block the tool call
    //    allow -> skip user authorization (mode decision still applies)
    //    pass  -> continue normal flow
    //    modifyInput -> replace command
    const hookInput: Record<string, unknown> = { command, description, host: host.name };
    const hookResult = await executePreToolUseHooks(
      toolName,
      hookInput,
      enabledHooks,
      defaultExecutor,
    );

    if (hookResult.decision === 'deny') {
      const blockMsg = hookResult.blockMessage ?? 'Blocked by hook';
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
        blockedReason: blockMsg,
        authorization: 'blocked',
      });
      return {
        proceed: false,
        reason: blockMsg,
        commandType: 'BLOCKED',
        authorization: 'blocked',
      };
    }

    const skipAuthorization = hookResult.decision === 'allow';
    const modifiedCommand =
      typeof hookResult.modifiedInput?.command === 'string'
        ? (hookResult.modifiedInput.command as string)
        : undefined;

    // 3. Mode decision - reads from modeHolder so ExitPlanMode can switch
    //    mode mid-loop (plan -> operator) without recreating tools.
    const decision = decideByMode(modeHolder.mode, commandType);
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

    // 4. Authorization (if needed) - skipped when a PreToolUse hook said allow
    if (decision.needsApproval && !skipAuthorization) {
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
        safetyMode: modeHolder.mode,
        backupPaths,
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
      return {
        proceed: true,
        commandType,
        authorization: 'approved',
        backup: response.backup,
        modifiedCommand,
      };
    }

    // Auto-approved (READ in any mode, or anything in autopilot).
    // In autopilot mode, WRITE/SUDO commands are auto-approved — if the AI
    // provided backup_paths, set backup: true so backups are still created.
    // Without this, autopilot mode would skip backups even when requested.
    // Also reached when a PreToolUse hook said "allow" (skipAuthorization).
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
    return {
      proceed: true,
      commandType,
      authorization: 'auto',
      backup: !!backupPaths,
      modifiedCommand,
    };
  }

  // ── Audit logging helper ────────────────────────────────────────────────
  function recordAudit(rec: ToolExecutionRecord): void {
    try {
      auditStore.create({
        sessionId: rec.sessionId,
        hostId: rec.hostId,
        hostName: rec.hostName,
        hostIp: rec.hostIp,
        safetyMode: modeHolder.mode,
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

  // ── READ-only tool executor helper (#13) ────────────────────────────────
  // Executes a pre-built safe command via SSH. All ops tools use this since
  // they are READ-only - no authorization needed, just audit + stream result.
  async function execReadTool(
    hostName: string | undefined,
    toolName: string,
    command: string,
    description: string,
  ) {
    const toolCallId = `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { host } = resolveHost(hostName);

    onToolCall({
      toolCallId,
      toolName,
      hostId: host.id,
      hostName: host.name,
      command,
      description,
      commandType: 'READ',
      needsApproval: false,
    });

    const release = await guard.acquireRead();
    try {
      const manager = await connectionPool.get(host.id);
      const result = await execCommand(manager, command);
      const success = result.exitCode === 0;

      // PostToolUse hooks (P1-3 fix: was missing for execReadTool)
      const postResult = await executePostToolUseHooks(
        toolName,
        { command },
        { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
        enabledHooks,
        defaultExecutor,
      );
      const effectiveStdout = postResult.additionalContext
        ? `${result.stdout}\n\n[Hook Context]\n${postResult.additionalContext}`
        : result.stdout;

      onToolResult({
        toolCallId,
        toolName,
        success,
        stdout: effectiveStdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        authorization: 'auto',
      });

      recordAudit({
        sessionId: context.sessionId,
        hostId: host.id,
        hostName: host.name,
        hostIp: host.host,
        toolName,
        command,
        description,
        commandType: 'READ',
        authorization: 'auto',
        exitCode: result.exitCode ?? undefined,
        durationMs: result.durationMs,
        outputSummary: truncateOutput(result.stdout || result.stderr),
      });

      // Large result persistence (P1-1)
      if (shouldPersist(result.stdout, result.stderr)) {
        return persistToolResult(context.sessionId, toolCallId, {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          command,
          hostName: host.name,
          toolName,
        });
      }

      return {
        stdout: effectiveStdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      };
    } catch (err) {
      const errMsg = formatSshError(err as Error, host.name);
      onToolResult({
        toolCallId,
        toolName,
        success: false,
        stderr: errMsg,
        authorization: 'auto',
      });
      recordAudit({
        sessionId: context.sessionId,
        hostId: host.id,
        hostName: host.name,
        hostIp: host.host,
        toolName,
        command,
        description,
        commandType: 'READ',
        authorization: 'auto',
        exitCode: -1,
        blockedReason: errMsg,
      });
      return { error: errMsg };
    } finally {
      release();
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
        backup_paths: z
          .array(z.string())
          .optional()
          .describe(
            'File paths to backup before executing this command. ' +
              'Use when the command modifies files (e.g., sed -i, cp, mv). ' +
              'The user will see a "backup before modification" option in the authorization dialog.',
          ),
      }),
      execute: async ({ host: hostName, command, description, backup_paths }) => {
        const toolCallId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { host } = resolveHost(hostName);
        const sanitized = sanitizeCommand(command);

        const pre = await preExec(toolCallId, 'exec', sanitized, host, description, backup_paths);
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

        const effectiveCommand = pre.modifiedCommand ?? sanitized;

        // P1-1: Concurrency guard - READ shares a semaphore, WRITE/SUDO
        // uses a per-host mutex to serialize mutations.
        const release: ReleaseFunction =
          pre.commandType === 'READ'
            ? await guard.acquireRead()
            : await guard.acquireWrite(host.id);

        try {
          const manager = await connectionPool.get(host.id);

          // Backup files before executing — only if the user checked
          // "backup before modification" in the AuthDialog and the AI
          // provided backup_paths.
          if (pre.backup && backup_paths && backup_paths.length > 0) {
            for (const bp of backup_paths) {
              const backupPath = `${bp}.opsagent-bak-${Date.now()}`;
              try {
                await execCommand(
                  manager,
                  `test -f ${shellQuote(bp)} && cp -p ${shellQuote(bp)} ${shellQuote(backupPath)} || true`,
                );
                logger.info(`[Tool] Backup created: ${backupPath}`);
              } catch (backupErr) {
                logger.warn(
                  `[Tool] Backup failed for ${bp} (non-fatal): ${(backupErr as Error).message}`,
                );
              }
            }
          }

          // Track whether any output was streamed — if so, don't retry
          // (the command may have had side effects).
          let hasStreamedOutput = false;
          // Pass onStream callback to emit incremental output chunks to the
          // UI. Each chunk fires as a partial result — the renderer appends
          // to the existing card's output instead of replacing.
          const result = await withRetry(
            () =>
              execCommand(manager, effectiveCommand, (chunk) => {
                hasStreamedOutput = true;
                onToolResult({
                  toolCallId,
                  toolName: 'exec',
                  success: true,
                  stdout: chunk.stream === 'stdout' ? chunk.data : undefined,
                  stderr: chunk.stream === 'stderr' ? chunk.data : undefined,
                  authorization: pre.authorization,
                  partial: true,
                });
              }),
            { maxRetries: 2, delays: [1000, 2000], hasSideEffects: () => hasStreamedOutput },
          );
          const success = result.exitCode === 0;

          // PostToolUse hooks - append additionalContext to stdout
          const postResult = await executePostToolUseHooks(
            'exec',
            { command: effectiveCommand },
            { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
            enabledHooks,
            defaultExecutor,
          );
          const effectiveStdout = postResult.additionalContext
            ? `${result.stdout}\n\n[Hook Context]\n${postResult.additionalContext}`
            : result.stdout;

          onToolResult({
            toolCallId,
            toolName: 'exec',
            success,
            stdout: effectiveStdout,
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
            command: effectiveCommand,
            description,
            commandType: pre.commandType,
            authorization: pre.authorization,
            exitCode: result.exitCode ?? undefined,
            durationMs: result.durationMs,
            outputSummary: truncateOutput(result.stdout || result.stderr),
          });

          // P1-1: Large result persistence
          if (shouldPersist(result.stdout, result.stderr)) {
            return persistToolResult(context.sessionId, toolCallId, {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              command: effectiveCommand,
              hostName: host.name,
              toolName: 'exec',
            });
          }

          return {
            stdout: effectiveStdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          };
        } catch (err) {
          const errMsg = formatSshError(err as Error, host.name);
          // Invalidate the connection on exec failure - the SSH session
          // layer may be broken (zombie connection) even though the TCP
          // socket is alive. This forces a fresh connection on next call.
          if (isConnectionError(err as Error)) {
            logger.warn(`[Tool] Connection error on exec, invalidating: ${(err as Error).message}`);
            connectionPool.invalidate(host.id);
          }
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
        } finally {
          release();
        }
      },
    }),

    sudo_exec: tool({
      description: 'Execute a command with sudo privileges on a remote SSH server.',
      parameters: z.object({
        host: z.string().optional().describe('Target host name'),
        command: z.string().describe('Shell command to execute with sudo'),
        description: z.string().describe('Purpose of this command'),
        backup_paths: z
          .array(z.string())
          .optional()
          .describe(
            'File paths to backup before executing this command. ' +
              'Use when the command modifies files (e.g., sed -i, cp, mv).',
          ),
      }),
      execute: async ({ host: hostName, command, description, backup_paths }) => {
        const toolCallId = `sudo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { host } = resolveHost(hostName);
        const sanitized = sanitizeCommand(command);

        const pre = await preExec(
          toolCallId,
          'sudo_exec',
          sanitized,
          host,
          description,
          backup_paths,
        );
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

        const effectiveCommand = pre.modifiedCommand ?? sanitized;

        // P1-1: Concurrency guard - READ shares a semaphore, WRITE/SUDO
        // uses a per-host mutex to serialize mutations.
        const release: ReleaseFunction =
          pre.commandType === 'READ'
            ? await guard.acquireRead()
            : await guard.acquireWrite(host.id);

        try {
          const manager = await connectionPool.get(host.id);

          // Backup files before executing — only if the user checked
          // "backup before modification" in the AuthDialog.
          if (pre.backup && backup_paths && backup_paths.length > 0) {
            for (const bp of backup_paths) {
              const backupPath = `${bp}.opsagent-bak-${Date.now()}`;
              try {
                await execCommand(
                  manager,
                  `test -f ${shellQuote(bp)} && cp -p ${shellQuote(bp)} ${shellQuote(backupPath)} || true`,
                );
                logger.info(`[Tool] Backup created: ${backupPath}`);
              } catch (backupErr) {
                logger.warn(
                  `[Tool] Backup failed for ${bp} (non-fatal): ${(backupErr as Error).message}`,
                );
              }
            }
          }

          let hasStreamedOutput = false;
          const result = await withRetry(
            () =>
              sudoExecCommand(manager, effectiveCommand, (chunk) => {
                hasStreamedOutput = true;
                onToolResult({
                  toolCallId,
                  toolName: 'sudo_exec',
                  success: true,
                  stdout: chunk.stream === 'stdout' ? chunk.data : undefined,
                  stderr: chunk.stream === 'stderr' ? chunk.data : undefined,
                  authorization: pre.authorization,
                  partial: true,
                });
              }),
            { maxRetries: 2, delays: [1000, 2000], hasSideEffects: () => hasStreamedOutput },
          );
          const success = result.exitCode === 0;

          // PostToolUse hooks - append additionalContext to stdout
          const postResult = await executePostToolUseHooks(
            'sudo_exec',
            { command: effectiveCommand },
            { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
            enabledHooks,
            defaultExecutor,
          );
          const effectiveStdout = postResult.additionalContext
            ? `${result.stdout}\n\n[Hook Context]\n${postResult.additionalContext}`
            : result.stdout;

          onToolResult({
            toolCallId,
            toolName: 'sudo_exec',
            success,
            stdout: effectiveStdout,
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
            command: effectiveCommand,
            description,
            commandType: 'SUDO',
            authorization: pre.authorization,
            exitCode: result.exitCode ?? undefined,
            durationMs: result.durationMs,
            outputSummary: truncateOutput(result.stdout || result.stderr),
          });

          // P1-1: Large result persistence
          if (shouldPersist(result.stdout, result.stderr)) {
            return persistToolResult(context.sessionId, toolCallId, {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              command: effectiveCommand,
              hostName: host.name,
              toolName: 'sudo_exec',
            });
          }

          return {
            stdout: effectiveStdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          };
        } catch (err) {
          const errMsg = formatSshError(err as Error, host.name);
          // Invalidate the connection on exec failure (same as exec tool)
          if (isConnectionError(err as Error)) {
            logger.warn(
              `[Tool] Connection error on sudo_exec, invalidating: ${(err as Error).message}`,
            );
            connectionPool.invalidate(host.id);
          }
          onToolResult({
            toolCallId,
            toolName: 'sudo_exec',
            success: false,
            stderr: errMsg,
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
            exitCode: -1,
            blockedReason: errMsg,
          });
          return { error: errMsg, blocked: false };
        } finally {
          release();
        }
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

        const release = await guard.acquireRead();
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
        } finally {
          release();
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

        // write_file is always WRITE — goes through normal authorization flow.
        // Pass backupPaths so the AuthDialog can show a "backup before modification"
        // checkbox. The backup only happens if the user checks it.
        const pre = await preExec(
          toolCallId,
          'write_file',
          `write_file ${path}`,
          host,
          description ?? `Write to ${path}`,
          [path],
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

        const release = await guard.acquireWrite(host.id);
        try {
          const manager = await connectionPool.get(host.id);

          // Backup the existing file before overwriting — only if the user
          // checked "backup before modification" in the AuthDialog.
          // Creates a timestamped copy that can be restored via rollback tool.
          let backupPath: string | undefined;
          if (pre.backup) {
            backupPath = `${path}.opsagent-bak-${Date.now()}`;
            try {
              await execCommand(
                manager,
                `test -f ${shellQuote(path)} && cp -p ${shellQuote(path)} ${shellQuote(backupPath)} || true`,
              );
              logger.info(`[Tool] Backup created: ${backupPath}`);
            } catch (backupErr) {
              // Backup failure is non-fatal — log and continue with the write.
              logger.warn(`[Tool] Backup failed (non-fatal): ${(backupErr as Error).message}`);
              backupPath = undefined;
            }
          }

          const result = await writeFile(manager, path, content);

          // PostToolUse hooks - append additionalContext to stdout
          const postResult = await executePostToolUseHooks(
            'write_file',
            { path },
            { stdout: `Wrote ${result.bytesWritten} bytes to ${path}`, exitCode: 0 },
            enabledHooks,
            defaultExecutor,
          );
          const writeMsg = backupPath
            ? `Wrote ${result.bytesWritten} bytes to ${path} (backup: ${backupPath})`
            : `Wrote ${result.bytesWritten} bytes to ${path}`;
          const effectiveStdout = postResult.additionalContext
            ? `${writeMsg}\n\n[Hook Context]\n${postResult.additionalContext}`
            : writeMsg;

          onToolResult({
            toolCallId,
            toolName: 'write_file',
            success: true,
            stdout: effectiveStdout,
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
            outputSummary: backupPath
              ? `Wrote ${result.bytesWritten} bytes (backup: ${backupPath})`
              : `Wrote ${result.bytesWritten} bytes`,
          });
          return { bytesWritten: result.bytesWritten, path: result.remotePath, backupPath };
        } catch (err) {
          onToolResult({
            toolCallId,
            toolName: 'write_file',
            success: false,
            stderr: (err as Error).message,
            authorization: pre.authorization,
          });
          return { error: (err as Error).message };
        } finally {
          release();
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

    rollback: tool({
      description:
        'Restore a file from the most recent OpsAgent backup. ' +
        'Finds the latest .opsagent-bak-* file for the given path and copies it back.',
      parameters: z.object({
        host: z.string().optional().describe('Target host name'),
        path: z.string().describe('Original file path to restore from backup'),
      }),
      execute: async ({ host: hostName, path }) => {
        const toolCallId = `rollback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { host } = resolveHost(hostName);

        // rollback is always WRITE — goes through normal authorization flow
        const pre = await preExec(
          toolCallId,
          'rollback',
          `rollback ${path}`,
          host,
          `Restore ${path} from backup`,
        );
        if (!pre.proceed) {
          recordAudit({
            sessionId: context.sessionId,
            hostId: host.id,
            hostName: host.name,
            hostIp: host.host,
            toolName: 'rollback',
            command: `rollback ${path}`,
            description: `Restore ${path} from backup`,
            commandType: pre.commandType,
            authorization: pre.authorization,
            blockedReason: pre.reason,
          });
          return { error: pre.reason, blocked: true };
        }

        const release = await guard.acquireWrite(host.id);
        try {
          const manager = await connectionPool.get(host.id);
          // Find the most recent backup file for this path.
          // Use `find` with `-name` (find does its own glob matching, so
          // quoting the pattern is correct — unlike `ls` where quoting
          // prevents shell glob expansion).
          const lastSlash = path.lastIndexOf('/');
          const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : '.';
          const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
          const listResult = await execCommand(
            manager,
            `find ${shellQuote(dir)} -maxdepth 1 -name ${shellQuote(`${basename}.opsagent-bak-*`)} -type f -exec ls -t {} + 2>/dev/null | head -1`,
          );
          const backupPath = listResult.stdout.trim();
          if (!backupPath) {
            const msg = `No backup found for ${path}`;
            onToolResult({
              toolCallId,
              toolName: 'rollback',
              success: false,
              stderr: msg,
              authorization: pre.authorization,
            });
            return { error: msg };
          }

          // Restore: copy backup back to original path
          const restoreResult = await execCommand(
            manager,
            `cp -p ${shellQuote(backupPath)} ${shellQuote(path)}`,
          );
          const success = restoreResult.exitCode === 0;
          onToolResult({
            toolCallId,
            toolName: 'rollback',
            success,
            stdout: success ? `Restored ${path} from ${backupPath}` : undefined,
            stderr: success ? undefined : restoreResult.stderr,
            exitCode: restoreResult.exitCode,
            authorization: pre.authorization,
          });
          recordAudit({
            sessionId: context.sessionId,
            hostId: host.id,
            hostName: host.name,
            hostIp: host.host,
            toolName: 'rollback',
            command: `rollback ${path}`,
            description: `Restore ${path} from ${backupPath}`,
            commandType: 'WRITE',
            authorization: pre.authorization,
            exitCode: restoreResult.exitCode ?? undefined,
            outputSummary: success
              ? `Restored from ${backupPath}`
              : `Failed: ${restoreResult.stderr}`,
          });
          return success ? { restored: true, path, backupPath } : { error: restoreResult.stderr };
        } catch (err) {
          const errMsg = formatSshError(err as Error, host.name);
          onToolResult({
            toolCallId,
            toolName: 'rollback',
            success: false,
            stderr: errMsg,
            authorization: pre.authorization,
          });
          recordAudit({
            sessionId: context.sessionId,
            hostId: host.id,
            hostName: host.name,
            hostIp: host.host,
            toolName: 'rollback',
            command: `rollback ${path}`,
            description: `Restore ${path} from backup`,
            commandType: 'WRITE',
            authorization: pre.authorization,
            exitCode: -1,
            blockedReason: errMsg,
          });
          return { error: errMsg };
        } finally {
          release();
        }
      },
    }),

    // ── Structured ops tools (#13) ──────────────────────────────────────────
    // All 7 tools are READ-only - they execute pre-built safe commands via SSH
    // and return structured output. No authorization needed (READ in all modes).
    tail_log: tool({
      description: 'Read the last N lines of a log file on a remote host.',
      parameters: z.object({
        host: z.string().optional().describe('Target host name'),
        path: z.string().describe('Remote file path to read'),
        lines: z.number().optional().describe('Number of lines to read (default 200)'),
        follow: z.boolean().optional().describe('Follow the file (tail -f)'),
      }),
      execute: async ({ host: hostName, path, lines, follow }) => {
        return execReadTool(
          hostName,
          'tail_log',
          buildTailLogCommand(path, lines, follow),
          `tail ${path}`,
        );
      },
    }),

    search_logs: tool({
      description: 'Search for a pattern across log files with context lines.',
      parameters: z.object({
        host: z.string().optional().describe('Target host name'),
        pattern: z.string().describe('Search pattern (regex)'),
        paths: z.array(z.string()).describe('Log file paths to search'),
        contextLines: z.number().optional().describe('Lines of context around matches (default 0)'),
        caseInsensitive: z.boolean().optional().describe('Case-insensitive search'),
        maxResults: z.number().optional().describe('Max results to return'),
      }),
      execute: async ({
        host: hostName,
        pattern,
        paths,
        contextLines,
        caseInsensitive,
        maxResults,
      }) => {
        return execReadTool(
          hostName,
          'search_logs',
          buildSearchLogsCommand(pattern, paths, { contextLines, caseInsensitive, maxResults }),
          `search "${pattern}" in ${paths.length} files`,
        );
      },
    }),

    journal_query: tool({
      description: 'Query the systemd journal on a remote host.',
      parameters: z.object({
        host: z.string().optional().describe('Target host name'),
        unit: z.string().optional().describe('Systemd unit name (e.g. nginx, sshd)'),
        priority: z
          .string()
          .optional()
          .describe('Priority filter: emerg, alert, crit, err, warning, notice, info, debug'),
        since: z
          .string()
          .optional()
          .describe('Show entries since this time (e.g. "1 hour ago", "2024-01-01")'),
        until: z.string().optional().describe('Show entries until this time'),
        lines: z.number().optional().describe('Max lines to return (default 100)'),
      }),
      execute: async ({ host: hostName, unit, priority, since, until, lines }) => {
        return execReadTool(
          hostName,
          'journal_query',
          buildJournalQueryCommand({ unit, priority, since, until, lines }),
          `journalctl ${unit ?? 'all'}`,
        );
      },
    }),

    process_list: tool({
      description: 'List processes on a remote host with sorting and filtering.',
      parameters: z.object({
        host: z.string().optional().describe('Target host name'),
        sortBy: z
          .enum(['cpu', 'mem', 'pid'])
          .optional()
          .describe('Sort by: cpu, mem, or pid (default cpu)'),
        filter: z.string().optional().describe('Filter processes by name pattern'),
        top: z.number().optional().describe('Show top N processes (default 20)'),
      }),
      execute: async ({ host: hostName, sortBy, filter, top }) => {
        return execReadTool(
          hostName,
          'process_list',
          buildProcessListCommand({ sortBy, filter, top }),
          'ps aux sorted',
        );
      },
    }),

    service_status: tool({
      description: 'Check systemd service status on a remote host.',
      parameters: z.object({
        host: z.string().optional().describe('Target host name'),
        unit: z
          .string()
          .optional()
          .describe('Service unit name (e.g. nginx). If omitted, lists all failed services.'),
      }),
      execute: async ({ host: hostName, unit }) => {
        return execReadTool(
          hostName,
          'service_status',
          buildServiceStatusCommand(unit),
          `systemctl status ${unit ?? 'failed'}`,
        );
      },
    }),

    disk_analysis: tool({
      description: 'Analyze disk usage on a remote host with depth control.',
      parameters: z.object({
        host: z.string().optional().describe('Target host name'),
        path: z.string().optional().describe('Path to analyze (default /)'),
        depth: z.number().optional().describe('Max depth of subdirectories (default 1)'),
        top: z.number().optional().describe('Show top N entries (default 20)'),
      }),
      execute: async ({ host: hostName, path, depth, top }) => {
        return execReadTool(
          hostName,
          'disk_analysis',
          buildDiskAnalysisCommand(path, depth, top),
          `du ${path ?? '/'}`,
        );
      },
    }),

    network_connections: tool({
      description: 'List active network connections on a remote host.',
      parameters: z.object({
        host: z.string().optional().describe('Target host name'),
        port: z.number().optional().describe('Filter by port number'),
        state: z
          .string()
          .optional()
          .describe('Filter by connection state (e.g. LISTEN, ESTABLISHED)'),
      }),
      execute: async ({ host: hostName, port, state }) => {
        return execReadTool(
          hostName,
          'network_connections',
          buildNetworkConnectionsCommand({ port, state }),
          'ss -tunap',
        );
      },
    }),

    read_tool_result: tool({
      description:
        'Read the full content of a previously persisted tool result. ' +
        'Use when a tool returned a truncated preview with fullResultPath.',
      parameters: z.object({
        path: z.string().describe('The fullResultPath returned by the previous tool call'),
      }),
      execute: async ({ path }) => {
        try {
          const data = readPersistedResult(path);
          return {
            stdout: data.stdout,
            stderr: data.stderr,
            exitCode: data.exitCode,
            command: data.command,
            hostName: data.hostName,
            toolName: data.toolName,
            timestamp: data.timestamp,
          };
        } catch (err) {
          return { error: `Failed to read persisted result: ${(err as Error).message}` };
        }
      },
    }),

    get_skill_content: tool({
      description:
        "Get the full content of a skill by name. Skills are listed in the system prompt metadata. Use this to load the complete diagnostic procedure when the user's request matches a skill but they haven't explicitly invoked it via /skillName.",
      parameters: z.object({
        name: z.string().describe('The skill name (e.g., "nginx-diagnosis", "system-diagnosis")'),
      }),
      execute: async ({ name }) => {
        const content = getSkillContent(name);
        if (!content) {
          const available = listAllSkills()
            .map((s) => s.name)
            .join(', ');
          return {
            error: `技能 '${name}' 不存在。可用技能: ${available}`,
          };
        }
        return { name, content };
      },
    }),

    install_skill: tool({
      description:
        'Install a new skill from user request. Creates a SKILL.md file that can be invoked via /skillName. Use when the user asks to install or create a skill.',
      parameters: z.object({
        name: z
          .string()
          .describe('Skill name in kebab-case (e.g., "redis-diagnosis", "nginx-troubleshoot")'),
        description: z.string().describe('Short description of what this skill covers'),
        content: z
          .string()
          .describe('The full markdown content of the skill - diagnostic steps, commands, etc.'),
        whenToUse: z
          .string()
          .optional()
          .describe('When this skill should be used (e.g., "当用户报告 Redis 相关问题时")'),
      }),
      execute: async ({ name, description, content, whenToUse }) => {
        const result = installSkill(name, content, description, whenToUse);
        if (!result.ok) {
          return { error: result.error };
        }
        return {
          success: true,
          message: `技能 '${name}' 已安装成功。用户可以通过 /${name} 调用该技能。`,
        };
      },
    }),

    todo_write: todoWriteTool,
    update_memory: updateMemoryTool,
    ...(exitPlanModeTool ? { exit_plan_mode: exitPlanModeTool } : {}),
    ...(askUserTool ? { ask_user: askUserTool } : {}),
  };
}

// Truncate output for audit log storage (keep full output in tool_calls
// table if needed later; audit_logs stores only summary).
function truncateOutput(text: string, maxChars = 2000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... [truncated, ${text.length - maxChars} more chars]`;
}

// Quote a file path for safe use in shell commands. Wraps the path in
// single quotes and escapes any embedded single quotes. Used by the
// backup/rollback logic in write_file and rollback tools.
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
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

// Check if an error is transient (worth retrying).
// Connection resets, timeouts, and temporary network errors qualify.
// Authentication failures and command-level errors do not — retrying won't help.
function isTransientError(err: Error): boolean {
  const msg = err.message;
  if (msg.includes('SSH_TIMEOUT')) return true;
  if (msg.includes('ECONNRESET')) return true;
  if (msg.includes('EPIPE')) return true;
  if (msg.includes('Keepalive timeout')) return true;
  if (msg.includes('Socket closed')) return true;
  if (isConnectionError(err)) return true;
  return false;
}

// Check if an error indicates the SSH connection is broken and should be
// invalidated. This covers zombie connections where the TCP socket is alive
// but the SSH session layer is unusable.
function isConnectionError(err: Error): boolean {
  const msg = err.message;
  if (msg.includes('channel') || msg.includes('Channel')) return true;
  if (msg.includes('MaxSessions')) return true;
  if (msg.includes('ECONNRESET')) return true;
  if (msg.includes('EPIPE')) return true;
  if (msg.includes('Socket closed')) return true;
  if (msg.includes('Keepalive timeout')) return true;
  if (msg.includes('SSH_TIMEOUT')) return true;
  if (msg.includes('Connection lost')) return true;
  return false;
}

// Retry wrapper with exponential backoff. Only retries transient errors.
// IMPORTANT: retries only if no output was streamed — if the command started
// executing and produced output, retrying could cause duplicate side effects
// (e.g., restarting a service twice). The `hasSideEffects` callback lets the
// caller signal that the function has already produced observable output.
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; delays: number[]; hasSideEffects?: () => boolean },
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt === opts.maxRetries) break;
      if (!isTransientError(lastError)) break;
      // Don't retry if the command already produced output (side effects
      // may have occurred — retrying could be dangerous).
      if (opts.hasSideEffects?.()) {
        logger.warn(
          `[Tool] Transient error but output was already streamed, not retrying: ${lastError.message}`,
        );
        break;
      }
      logger.warn(
        `[Tool] Transient error on attempt ${attempt + 1}/${opts.maxRetries + 1}: ${lastError.message}. Retrying in ${opts.delays[attempt]}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, opts.delays[attempt]));
    }
  }
  throw lastError;
}
