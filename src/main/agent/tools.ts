import { z } from 'zod';
import { tool } from 'ai';
import { connectionPool, execCommand, sudoExecCommand, readFile, writeFile } from '../ssh/index.js';
import { hostsStore } from '../storage/hosts.js';
import { auditStore } from '../storage/audit.js';
import { hooksStore } from '../storage/hooks.js';
import { getSessionCostTotal } from '../storage/cost-store.js';
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
  StopRequestedRef,
} from './types.js';
import { createTodoWriteTool } from './tools/todo-write.js';
import { createUpdateMemoryTool } from './tools/update-memory.js';
import {
  installSkill,
  getSkillContent,
  listAllSkills,
  readSkillFile,
  type SkillFileInput,
} from './skills/index.js';
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
import { aggregateMultiHostResults, type MultiHostExecResult } from './multi-host.js';
import {
  registerRunningCommand,
  unregisterRunningCommand,
  abortRunningCommand,
} from '../ssh/running-command-registry.js';
import {
  buildTailLogCommand,
  buildSearchLogsCommand,
  buildJournalQueryCommand,
  buildProcessListCommand,
  buildServiceStatusCommand,
  buildDiskAnalysisCommand,
  buildNetworkConnectionsCommand,
} from './ops-commands.js';
import { revalidateEditedCommand, buildEditNotice } from './command-edit.js';
import { buildRejectionFeedback } from './rejection-feedback.js';

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
  // Phase B: shared ref so preExec can signal "user clicked 拒绝并停止" to the
  // loop. Optional with a default so existing callers/tests don't break.
  stopRequestedRef?: StopRequestedRef;
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
  // Default ref when not provided (backward compat for tests/older callers).
  const stopRequestedRef: StopRequestedRef = deps.stopRequestedRef ?? { current: false };
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

  // V3-07 Cycle B: in-flight ops-tool commands (tail_log, ...) are tracked in
  // the module-level singleton registry (running-command-registry.ts) so the
  // renderer's Stop button can reach them via the stop-tool IPC handler.
  // registerRunningCommand / unregisterRunningCommand / abortRunningCommand
  // are used below; stop_tail calls abortRunningCommand directly.

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
    // Phase A: true when the executed command was user-edited in the AuthDialog.
    editedByUser?: boolean;
    // Phase B: true when the user rejected via "拒绝并停止". Signals the loop
    // (via stopRequestedRef) to break and run a wind-down turn.
    stopRequested?: boolean;
    // Phase B: model-facing error message (long, instructional). When set,
    // tools use this instead of `reason` for the tool result returned to the
    // model, so the model sees explicit "don't retry / use ask_user" guidance.
    modelError?: string;
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
        // Phase B: "拒绝并停止" sets the shared ref so the loop breaks and
        // runs a wind-down turn instead of continuing to propose commands.
        if (response.stopRequested) {
          stopRequestedRef.current = true;
        }
        onToolResult({
          toolCallId,
          toolName,
          success: false,
          blockedReason: response.reason ?? 'User rejected',
          authorization: 'rejected',
          // Carry the command + stopRequested so the loop's denial tracker can
          // reference the rejected command and detect a stop request.
          command,
          stopRequested: response.stopRequested,
        });
        return {
          proceed: false,
          reason: response.reason ?? 'User rejected',
          commandType,
          authorization: 'rejected',
          stopRequested: response.stopRequested,
          // Strong, instructional feedback for the model (names the rejected
          // command, says don't retry, use ask_user, and stop if requested).
          modelError: buildRejectionFeedback({
            command,
            userReason: response.reason,
            stopRequested: response.stopRequested,
          }),
        };
      }
      // Phase A: re-validate a user-edited command. The edit is user-supplied
      // at approval time, so it bypassed the security pipeline - re-run
      // sanitize + checkCommandSecurity. A blocked-rule hit blocks regardless
      // of the approval (defense-in-depth).
      const edit = revalidateEditedCommand(
        response.editedCommand,
        command,
        host.id,
        securityConfig,
      );
      let effectiveModifiedCommand = modifiedCommand;
      let effectiveCommandType = commandType;
      let editedByUser = false;
      if (edit.changed) {
        if (edit.blocked) {
          onToolResult({
            toolCallId,
            toolName,
            success: false,
            blockedReason: edit.reason,
            authorization: 'blocked',
            command,
          });
          return {
            proceed: false,
            reason: edit.reason,
            commandType: 'BLOCKED',
            authorization: 'blocked',
          };
        }
        effectiveModifiedCommand = edit.modifiedCommand;
        effectiveCommandType = edit.commandType ?? commandType;
        editedByUser = true;
      }
      return {
        proceed: true,
        commandType: effectiveCommandType,
        authorization: 'approved',
        backup: response.backup,
        modifiedCommand: effectiveModifiedCommand,
        editedByUser,
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
        outputSummary: rec.outputSummary ?? rec.blockedReason,
        editedByUser: rec.editedByUser,
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
    // V3-07 Cycle B: register an AbortController so stop_tail (or the UI stop
    // button) can cancel this in-flight command by toolCallId. Unregistered in
    // finally so the entry does not leak after the command finishes normally.
    const abortController = new AbortController();
    registerRunningCommand(toolCallId, abortController);
    try {
      const manager = await connectionPool.get(host.id);
      // V3-07: forward the onStream callback so ops tools (tail_log,
      // search_logs, journal_query, ...) emit incremental partial:true
      // onToolResult chunks - same pattern as exec/sudo_exec (see ~line 549).
      // Without this, a `tail -f` or long grep blocks until the host timeout
      // with nothing shown to the user. Each chunk appends to the existing
      // card's output in the renderer.
      const result = await execCommand(
        manager,
        command,
        (chunk) => {
          onToolResult({
            toolCallId,
            toolName,
            success: true,
            stdout: chunk.stream === 'stdout' ? chunk.data : undefined,
            stderr: chunk.stream === 'stderr' ? chunk.data : undefined,
            authorization: 'auto',
            partial: true,
          });
        },
        abortController.signal,
      );
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
      // V3-07 Cycle B: drop the AbortController entry on completion (normal or
      // error). If the command was aborted via stop_tail, abort() already
      // removed the entry and unregister is a harmless no-op.
      unregisterRunningCommand(toolCallId);
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
          // Use the model-facing feedback (buildRejectionFeedback) when present
          // so the model sees explicit guidance instead of a bare reason.
          return { error: pre.modelError ?? pre.reason, blocked: true };
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
          // Phase A: when the user edited the command, prepend a notice so the
          // model knows the command that actually ran differs from what it
          // proposed (otherwise subsequent steps reference the original).
          const editNotice = pre.editedByUser ? buildEditNotice(effectiveCommand) : '';
          const modelStdout = editNotice + effectiveStdout;

          onToolResult({
            toolCallId,
            toolName: 'exec',
            success,
            stdout: modelStdout,
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
            editedByUser: pre.editedByUser,
          });

          // P1-1: Large result persistence
          if (shouldPersist(result.stdout, result.stderr)) {
            const persisted = persistToolResult(context.sessionId, toolCallId, {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              command: effectiveCommand,
              hostName: host.name,
              toolName: 'exec',
            });
            return {
              ...persisted,
              preview: editNotice + persisted.preview,
              ...(pre.editedByUser ? { command: effectiveCommand, userEdited: true } : {}),
            };
          }

          return {
            stdout: modelStdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            ...(pre.editedByUser ? { command: effectiveCommand, userEdited: true } : {}),
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
            command: effectiveCommand,
            description,
            commandType: pre.commandType,
            authorization: pre.authorization,
            exitCode: -1,
            blockedReason: errMsg,
            editedByUser: pre.editedByUser,
          });
          return { error: errMsg, blocked: false };
        } finally {
          release();
        }
      },
    }),

    exec_multi: tool({
      description:
        'Execute a READ-only shell command on MULTIPLE hosts in parallel and ' +
        'return an aggregated comparison. Use for cross-host checks like ' +
        '"df -h on all web servers" or "systemctl status nginx on every node". ' +
        'WRITE/SUDO commands are rejected - use exec per-host for those. ' +
        'The summary flags divergent outputs so you can spot hosts that differ.',
      parameters: z.object({
        command: z.string().describe('READ-only shell command to run on every target host'),
        hosts: z
          .array(z.string())
          .optional()
          .describe('Target host names. If omitted, runs on ALL hosts selected for the session.'),
        description: z
          .string()
          .describe('Purpose of this command - explain WHY you are running it on multiple hosts'),
      }),
      execute: async ({ command, hosts: hostNames, description }) => {
        const toolCallId = `exec_multi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const sanitized = sanitizeCommand(command);

        // Resolve the target set: explicit hostNames, else all session hosts.
        // Dedupe by host id (L1 fix) so `hosts: ['web-1','web-1']` doesn't run
        // twice on the same host (which would collide perHostIds + byHost keys).
        const sessionHosts = context.hostIds
          .map((id) => hostsStore.get(id))
          .filter((h): h is NonNullable<typeof h> => h !== null);
        const requestedTargets =
          hostNames && hostNames.length > 0
            ? hostNames.map((n) => {
                try {
                  return resolveHost(n).host;
                } catch {
                  return null;
                }
              })
            : sessionHosts;
        // Track unknown host names (M2 fix) so the model sees what was skipped.
        const unknownHostNames =
          hostNames && hostNames.length > 0
            ? hostNames.filter((n) => {
                try {
                  resolveHost(n);
                  return false;
                } catch {
                  return true;
                }
              })
            : [];
        // Dedupe by id, preserving first-seen order.
        const seenIds = new Set<string>();
        const targets = requestedTargets.filter((h): h is NonNullable<typeof h> => {
          if (h === null || seenIds.has(h.id)) return false;
          seenIds.add(h.id);
          return true;
        });

        if (targets.length === 0) {
          return {
            error: 'No valid target hosts for exec_multi.',
            skippedHosts: unknownHostNames,
          };
        }

        // Global pre-check against the first host: reject WRITE/SUDO upfront so
        // we never start a fan-out for a non-READ command. (exec_multi is
        // READ-only in this first cut - per-host WRITE authorization across a
        // fan-out is deferred.) Per-host blocked rules are re-checked inside the
        // fan-out (H1 fix) so a host-specific block on a non-first target is
        // honored, not silently bypassed.
        const globalSec = checkCommandSecurity(sanitized, targets[0].id, securityConfig);
        if (globalSec.commandType !== 'READ' && globalSec.allowed) {
          return {
            error:
              `exec_multi only supports READ commands (classified as ${globalSec.commandType}). ` +
              'Use exec on each host individually for WRITE/SUDO operations.',
            blocked: true,
            skippedHosts: unknownHostNames,
          };
        }

        // Emit the aggregate tool-call card up front (M3 fix: a fully-blocked
        // command below still produces a card so the UI is consistent with exec).
        onToolCall({
          toolCallId,
          toolName: 'exec_multi',
          hostId: targets.length === 1 ? targets[0].id : undefined,
          hostName: targets.length === 1 ? targets[0].name : `${targets.length} hosts`,
          command: sanitized,
          description,
          commandType: 'READ',
          needsApproval: false,
        });

        // If the global pre-check blocked it (same command blocked everywhere
        // via global rules), record per-host blocked audits + a blocked card.
        if (!globalSec.allowed) {
          for (const h of targets) {
            recordAudit({
              sessionId: context.sessionId,
              hostId: h.id,
              hostName: h.name,
              hostIp: h.host,
              toolName: 'exec_multi',
              command: sanitized,
              description,
              commandType: 'BLOCKED',
              authorization: 'blocked',
              exitCode: -1,
              blockedReason: globalSec.reason,
            });
          }
          onToolResult({
            toolCallId,
            toolName: 'exec_multi',
            success: false,
            blockedReason: globalSec.reason,
            authorization: 'blocked',
          });
          return {
            error: globalSec.reason,
            blocked: true,
            skippedHosts: unknownHostNames,
          };
        }

        // Fan out: run the command on every target host in parallel. Each host
        // acquires its own read-semaphore slot (concurrency.ts caps parallelism)
        // and gets a per-host toolCallId so the UI shows distinct cards. A host
        // failure (SSH down, timeout) does NOT abort the others - allSettled.
        const settled = await Promise.allSettled(
          targets.map(async (h): Promise<MultiHostExecResult> => {
            const perHostId = `${toolCallId}__${h.name}`;
            // H1 fix: re-check security PER HOST. The global pre-check used
            // targets[0]; a host-specific blocked rule on this host must be
            // honored here, not silently bypassed. A blocked host returns a
            // failed result (does not execute) but does not abort the others.
            const hostSec = checkCommandSecurity(sanitized, h.id, securityConfig);
            if (!hostSec.allowed) {
              onToolResult({
                toolCallId: perHostId,
                toolName: 'exec_multi',
                success: false,
                blockedReason: hostSec.reason,
                authorization: 'blocked',
              });
              recordAudit({
                sessionId: context.sessionId,
                hostId: h.id,
                hostName: h.name,
                hostIp: h.host,
                toolName: 'exec_multi',
                command: sanitized,
                description,
                commandType: 'BLOCKED',
                authorization: 'blocked',
                exitCode: -1,
                blockedReason: hostSec.reason,
              });
              return {
                hostName: h.name,
                ok: false,
                exitCode: null,
                stdout: '',
                stderr: `blocked: ${hostSec.reason}`,
                durationMs: 0,
              };
            }
            const release = await guard.acquireRead();
            try {
              const manager = await connectionPool.get(h.id);
              const result = await execCommand(manager, sanitized, (chunk) => {
                onToolResult({
                  toolCallId: perHostId,
                  toolName: 'exec_multi',
                  success: true,
                  stdout: chunk.stream === 'stdout' ? chunk.data : undefined,
                  stderr: chunk.stream === 'stderr' ? chunk.data : undefined,
                  authorization: 'auto',
                  partial: true,
                });
              });
              const success = result.exitCode === 0;
              onToolResult({
                toolCallId: perHostId,
                toolName: 'exec_multi',
                success,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                durationMs: result.durationMs,
                authorization: 'auto',
              });
              recordAudit({
                sessionId: context.sessionId,
                hostId: h.id,
                hostName: h.name,
                hostIp: h.host,
                toolName: 'exec_multi',
                command: sanitized,
                description,
                commandType: 'READ',
                authorization: 'auto',
                exitCode: result.exitCode ?? undefined,
                durationMs: result.durationMs,
                outputSummary: truncateOutput(result.stdout || result.stderr),
              });
              return {
                hostName: h.name,
                ok: success,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                durationMs: result.durationMs,
              };
            } catch (err) {
              const errMsg = formatSshError(err as Error, h.name);
              if (isConnectionError(err as Error)) {
                connectionPool.invalidate(h.id);
              }
              onToolResult({
                toolCallId: `${toolCallId}__${h.name}`,
                toolName: 'exec_multi',
                success: false,
                stderr: errMsg,
                authorization: 'auto',
              });
              recordAudit({
                sessionId: context.sessionId,
                hostId: h.id,
                hostName: h.name,
                hostIp: h.host,
                toolName: 'exec_multi',
                command: sanitized,
                description,
                commandType: 'READ',
                authorization: 'auto',
                exitCode: -1,
                blockedReason: errMsg,
              });
              return {
                hostName: h.name,
                ok: false,
                exitCode: null,
                stdout: '',
                stderr: errMsg,
                durationMs: 0,
              };
            } finally {
              release();
            }
          }),
        );

        // allSettled never rejects; map to MultiHostExecResult (rejected -> fail).
        const results = settled.map((s, i) =>
          s.status === 'fulfilled'
            ? s.value
            : {
                hostName: targets[i].name,
                ok: false,
                exitCode: null,
                stdout: '',
                stderr: (s.reason as Error)?.message ?? 'rejected',
                durationMs: 0,
              },
        );

        const summary = aggregateMultiHostResults(results);
        // Emit a final aggregate card so the user sees the cross-host summary.
        onToolResult({
          toolCallId,
          toolName: 'exec_multi',
          success: summary.failedCount === 0,
          stdout: summary.summaryText,
          stderr: '',
          exitCode: summary.failedCount === 0 ? 0 : 1,
          authorization: 'auto',
        });

        return {
          summary: summary.summaryText,
          successCount: summary.successCount,
          failedCount: summary.failedCount,
          totalCount: summary.totalCount,
          divergent: summary.divergent,
          distinctOutputCount: summary.distinctOutputCount,
          byHost: summary.byHost,
          // M2 fix: surface host names that were requested but unresolvable
          // (not selected for the session / typo), so the model doesn't think
          // it ran on hosts that were silently dropped.
          skippedHosts: unknownHostNames,
        };
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
          return { error: pre.modelError ?? pre.reason, blocked: true };
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
          // Phase A: surface user edits to the model (see exec tool for rationale).
          const editNotice = pre.editedByUser ? buildEditNotice(effectiveCommand) : '';
          const modelStdout = editNotice + effectiveStdout;

          onToolResult({
            toolCallId,
            toolName: 'sudo_exec',
            success,
            stdout: modelStdout,
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
            editedByUser: pre.editedByUser,
          });

          // P1-1: Large result persistence
          if (shouldPersist(result.stdout, result.stderr)) {
            const persisted = persistToolResult(context.sessionId, toolCallId, {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              command: effectiveCommand,
              hostName: host.name,
              toolName: 'sudo_exec',
            });
            return {
              ...persisted,
              preview: editNotice + persisted.preview,
              ...(pre.editedByUser ? { command: effectiveCommand, userEdited: true } : {}),
            };
          }

          return {
            stdout: modelStdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            ...(pre.editedByUser ? { command: effectiveCommand, userEdited: true } : {}),
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
            command: effectiveCommand,
            description,
            commandType: 'SUDO',
            authorization: pre.authorization,
            exitCode: -1,
            blockedReason: errMsg,
            editedByUser: pre.editedByUser,
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
          return { error: pre.modelError ?? pre.reason, blocked: true };
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
          return { error: pre.modelError ?? pre.reason, blocked: true };
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

    stop_tail: tool({
      description:
        'Stop a currently running tail_log (or other long-running ops) command ' +
        'by its toolCallId. Use after starting a tail_log with follow=true when ' +
        'you have seen enough output. Returns whether a command was found and ' +
        'signaled to stop. The stopped command resolves with the partial output ' +
        'accumulated so far.',
      parameters: z.object({
        toolCallId: z.string().describe('The toolCallId of the running tail_log command to stop'),
      }),
      execute: async ({ toolCallId }) => {
        const stopped = abortRunningCommand(toolCallId);
        if (!stopped) {
          return {
            stopped: false,
            note: `No running command found for toolCallId ${toolCallId}. It may have already finished.`,
          };
        }
        return {
          stopped: true,
          note: `Signaled stop for toolCallId ${toolCallId}. The command will resolve with its partial output.`,
        };
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

    get_session_usage: tool({
      description:
        'Get the cumulative token usage and estimated USD cost for the CURRENT session. ' +
        "Use this to answer the user's meta-questions about token consumption or cost " +
        '(e.g. "当前使用了多少 token", "这次会话花了多少钱"). ' +
        'This tool queries local accounting only - it does NOT run any command on a host. ' +
        'Never run host commands to answer usage/cost questions.',
      parameters: z.object({}),
      execute: async () => {
        // Meta tool: no host, no security check, no authorization. Returns the
        // session's accumulated token totals + estimated cost so the model can
        // answer usage questions without touching a remote host.
        return getSessionCostTotal(context.sessionId);
      },
    }),

    get_skill_content: tool({
      description:
        "Get the full content of a skill by name. Skills are listed in the system prompt metadata. Use this to load the complete diagnostic procedure when the user's request matches a skill but they haven't explicitly invoked it via /skillName. The returned content includes a file manifest if the skill has scripts/references/assets - use read_skill_file to read individual files.",
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

    read_skill_file: tool({
      description:
        'Read a file from a skill directory by relative path. Skills may include scripts/, references/, and assets/ subdirectories. The file path is relative to the skill directory (e.g., "scripts/check.sh", "references/api-spec.md"). Use this after get_skill_content to load individual files listed in the manifest.',
      parameters: z.object({
        skillName: z.string().describe('The skill name (e.g., "redis-diagnosis")'),
        filePath: z.string().describe('Relative path within skill dir, e.g. "scripts/check.sh"'),
      }),
      execute: async ({ skillName, filePath }) => {
        const result = readSkillFile(skillName, filePath);
        if (!result.ok) {
          return { error: result.error };
        }
        return { skillName, filePath, content: result.content };
      },
    }),

    install_skill: tool({
      description:
        'Install a new skill from user request. Creates a SKILL.md file that can be invoked via /skillName. Use when the user asks to install or create a skill. Optionally include scripts/references/assets files.',
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
        files: z
          .array(
            z.object({
              path: z.string().describe('Relative path within skill dir, e.g. "scripts/check.sh"'),
              content: z.string().describe('File content'),
            }),
          )
          .optional()
          .describe('Additional files to install (scripts/references/assets)'),
      }),
      execute: async ({ name, description, content, whenToUse, files }) => {
        const result = installSkill(
          name,
          content,
          description,
          whenToUse,
          files as SkillFileInput[] | undefined,
        );
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
  if (isConnectionError(err)) return true;
  const msg = err.message;
  if (msg.includes('ECONNRESET')) return true;
  if (msg.includes('EPIPE')) return true;
  if (msg.includes('Keepalive timeout')) return true;
  if (msg.includes('Socket closed')) return true;
  return false;
}

// Check if an error indicates the SSH connection is broken and should be
// invalidated. This covers zombie connections where the TCP socket is alive
// but the SSH session layer is unusable.
//
// IMPORTANT: OpsAgentError stores the error category in `.code` (e.g.
// 'SSH_TIMEOUT'), not in `.message`. The message text is user-facing (e.g.
// "Command timed out after 60000ms") and does NOT contain the code string.
// We must check both .code and .message to catch all cases.
function isConnectionError(err: Error): boolean {
  // Check OpsAgentError.code first (authoritative category).
  const code = (err as { code?: string }).code;
  if (code === 'SSH_TIMEOUT' || code === 'SSH_NOT_CONNECTED') return true;

  const msg = err.message;
  if (msg.includes('channel') || msg.includes('Channel')) return true;
  if (msg.includes('MaxSessions')) return true;
  if (msg.includes('ECONNRESET')) return true;
  if (msg.includes('EPIPE')) return true;
  if (msg.includes('Socket closed')) return true;
  if (msg.includes('Keepalive timeout')) return true;
  if (msg.includes('Command timed out')) return true;
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
