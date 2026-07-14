import { ipcMain, type BrowserWindow } from 'electron';
import { Channels } from './channels.js';
import { logger } from '../utils/logger.js';
import { hostsStore } from '../storage/hosts.js';
import { modelsStore } from '../storage/models.js';
import { sessionsStore } from '../storage/sessions.js';
import { auditStore } from '../storage/audit.js';
import { settingsStore } from '../storage/settings.js';
import { customRulesStore } from '../storage/custom-rules.js';
import { hooksStore } from '../storage/hooks.js';
import { taskListsStore } from '../storage/task-lists.js';
import { runAgentLoop } from '../agent/loop.js';
import { exportSessionToMarkdown } from '../agent/export.js';
import { clearSummaryCache, compressContext, loadMessages } from '../agent/context.js';
import { cleanupSessionResults } from '../agent/tool-results.js';
import { analyzeContextBreakdown } from '../agent/context-breakdown.js';
import {
  listAllSkills,
  getEnabledSkills,
  getSkillContent,
  installSkill,
  deleteSkill,
  setSkillEnabled,
} from '../agent/skills/index.js';
import { getActiveModel } from '../agent/providers.js';
import { connectionPool, execCommand } from '../ssh/index.js';
import { registerTerminalHandlers, closeAllTerminals } from './terminal.js';
import type { AuthorizationResponse } from '../agent/types.js';
import type {
  AgentRunRequest,
  AgentAuthorizationResponse,
  AgentPlanApprovalResponse,
  AgentAskUserResponse,
} from './preload-api.js';
import type { TodoItem } from '../../shared/types.js';
import type { PlanApprovalResult } from '../agent/tools/exit-plan-mode.js';
import type { AskUserAnswer } from '../agent/tools/ask-user.js';

// Register all IPC handlers between renderer and main.
// Called once from electron/main.ts during app.whenReady().
// The mainWindow is needed for agent events (main → renderer streaming).

// Pending authorization requests keyed by toolCallId.
// When the agent loop requests authorization, we store a resolver here.
// When the renderer responds via 'agent:authorization-response', we resolve.
const pendingAuthorizations = new Map<string, (response: AuthorizationResponse) => void>();

// Pending plan approval requests keyed by sessionId (P0-1.B).
// Only one plan approval can be pending per session at a time.
const pendingPlanApprovals = new Map<string, (result: PlanApprovalResult) => void>();

// Pending ask-user requests keyed by sessionId (P1-4).
// Only one question dialog can be pending per session at a time.
const pendingAskUser = new Map<string, (answers: AskUserAnswer[]) => void>();

// Active agent loops keyed by sessionId. Each entry holds the AbortController
// used to genuinely terminate the streaming loop when the user clicks Stop.
const activeLoops = new Map<string, AbortController>();

let mainWindow: BrowserWindow | null = null;

export function registerIpcHandlers(win: BrowserWindow): void {
  mainWindow = win;
  // ---------- System ----------
  ipcMain.handle(Channels.System.PING, async () => {
    logger.debug('ping received');
    return 'pong';
  });

  // ---------- Hosts ----------
  ipcMain.handle(Channels.Hosts.LIST, async () => hostsStore.list());
  ipcMain.handle(Channels.Hosts.GET, async (_e, id: string) => hostsStore.get(id));
  ipcMain.handle(Channels.Hosts.CREATE, async (_e, payload) => hostsStore.create(payload));
  ipcMain.handle(Channels.Hosts.UPDATE, async (_e, id: string, payload) => {
    const result = hostsStore.update(id, payload);
    // Invalidate the cached connection and reset the circuit breaker
    // so the new config takes effect immediately.
    connectionPool.invalidate(id);
    return result;
  });
  ipcMain.handle(Channels.Hosts.DELETE, async (_e, id: string) => hostsStore.delete(id));
  ipcMain.handle(Channels.Hosts.TEST_CONNECTION, async (_e, id: string) => {
    try {
      const result = await connectionPool.testConnection(id);
      return { ok: true, latencyMs: result.latencyMs };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle(Channels.Hosts.LIST_STATUS, async () => connectionPool.listStatus());
  ipcMain.handle(Channels.Hosts.BATCH_CREATE, async (_e, payloads) =>
    hostsStore.batchCreate(payloads),
  );
  ipcMain.handle(Channels.Hosts.RENAME_GROUP, async (_e, oldName: string, newName: string) =>
    hostsStore.renameGroup(oldName, newName),
  );
  ipcMain.handle(Channels.Hosts.DELETE_GROUP, async (_e, groupName: string) =>
    hostsStore.deleteGroup(groupName),
  );
  ipcMain.handle(Channels.Hosts.LIST_GROUPS, async () => hostsStore.listGroups());

  // ---------- Models ----------
  ipcMain.handle(Channels.Models.LIST, async () => modelsStore.list());
  ipcMain.handle(Channels.Models.CREATE, async (_e, payload) => modelsStore.create(payload));
  ipcMain.handle(Channels.Models.UPDATE, async (_e, id: string, payload) =>
    modelsStore.update(id, payload),
  );
  ipcMain.handle(Channels.Models.DELETE, async (_e, id: string) => modelsStore.delete(id));
  ipcMain.handle(Channels.Models.SET_ACTIVE, async (_e, id: string) => modelsStore.setActive(id));
  ipcMain.handle(Channels.Models.GET_ACTIVE, async () => modelsStore.getActive());

  // ---------- Sessions ----------
  ipcMain.handle(Channels.Sessions.LIST, async () => sessionsStore.listSessions());
  ipcMain.handle(Channels.Sessions.GET, async (_e, id: string) => sessionsStore.getSession(id));
  ipcMain.handle(Channels.Sessions.CREATE, async (_e, payload) =>
    sessionsStore.createSession(payload),
  );
  ipcMain.handle(Channels.Sessions.UPDATE, async (_e, id: string, payload) =>
    sessionsStore.updateSession(id, payload),
  );
  ipcMain.handle(Channels.Sessions.DELETE, async (_e, id: string) => {
    // Abort any active agent loop for this session so the backend stops
    // cleanly instead of erroring on FK constraint failures when trying to
    // save messages to a session that no longer exists.
    activeLoops.get(id)?.abort();
    activeLoops.delete(id);
    // Clear the cached context summary so stale entries for the deleted
    // session don't linger. (Resolves the MEDIUM known issue from code
    // review: summaryCache was never cleared on session deletion.)
    clearSummaryCache(id);
    cleanupSessionResults(id);
    return sessionsStore.deleteSession(id);
  });
  ipcMain.handle(Channels.Sessions.MESSAGES, async (_e, sessionId: string) =>
    sessionsStore.listMessages(sessionId),
  );
  ipcMain.handle(Channels.Sessions.ADD_MESSAGE, async (_e, payload) =>
    sessionsStore.addMessage(payload),
  );
  ipcMain.handle(Channels.Sessions.EXPORT, async (_e, sessionId: string) =>
    exportSessionToMarkdown(sessionId),
  );
  ipcMain.handle(
    Channels.Sessions.DELETE_MESSAGES_AFTER,
    async (_e, sessionId: string, messageId: string) =>
      sessionsStore.deleteMessagesAfter(sessionId, messageId),
  );

  // ---------- Audit ----------
  ipcMain.handle(Channels.Audit.LIST, async (_e, filter) => auditStore.list(filter));
  ipcMain.handle(Channels.Audit.CREATE, async (_e, payload) => auditStore.create(payload));
  ipcMain.handle(Channels.Audit.VERIFY, async () => auditStore.verifyIntegrity());

  // ---------- Settings ----------
  ipcMain.handle(Channels.Settings.GET, async (_e, key: string) => settingsStore.get(key));
  ipcMain.handle(Channels.Settings.SET, async (_e, key: string, value: string) =>
    settingsStore.set(key, value),
  );
  ipcMain.handle(Channels.Settings.GET_ALL, async () => settingsStore.getAll());

  // ---------- Custom rules ----------
  ipcMain.handle(Channels.Rules.LIST, async () => customRulesStore.list());
  ipcMain.handle(Channels.Rules.CREATE, async (_e, payload) => customRulesStore.create(payload));
  ipcMain.handle(Channels.Rules.UPDATE, async (_e, id: string, payload) =>
    customRulesStore.update(id, payload),
  );
  ipcMain.handle(Channels.Rules.DELETE, async (_e, id: string) => customRulesStore.delete(id));

  // ---------- Hooks ----------
  ipcMain.handle(Channels.Hooks.LIST, async () => hooksStore.list());
  ipcMain.handle(Channels.Hooks.CREATE, async (_e, payload) => hooksStore.create(payload));
  ipcMain.handle(Channels.Hooks.UPDATE, async (_e, id: string, payload) =>
    hooksStore.update(id, payload),
  );
  ipcMain.handle(Channels.Hooks.DELETE, async (_e, id: string) => hooksStore.delete(id));

  // ---------- Agent ----------
  ipcMain.handle(Channels.Agent.RUN, async (_e, request: AgentRunRequest) => {
    if (!mainWindow) {
      throw new Error('Main window not available');
    }
    if (activeLoops.has(request.sessionId)) {
      throw new Error(`Agent loop already running for session ${request.sessionId}`);
    }

    const abortController = new AbortController();
    activeLoops.set(request.sessionId, abortController);
    const win = mainWindow;

    // Run the loop asynchronously — the handler returns immediately after
    // starting. All output flows via events (text-stream, tool-call, etc.).
    runAgentLoop({
      sessionId: request.sessionId,
      userMessage: request.userMessage,
      hostIds: request.hostIds,
      safetyMode: request.safetyMode,
      maxSteps: request.maxSteps,
      abortSignal: abortController.signal,
      onTextStream: (text) => {
        win.webContents.send(Channels.Agent.TEXT_STREAM, {
          sessionId: request.sessionId,
          text,
        });
      },
      onToolCall: (info) => {
        win.webContents.send(Channels.Agent.TOOL_CALL, {
          sessionId: request.sessionId,
          ...info,
        });
      },
      onToolResult: (result) => {
        win.webContents.send(Channels.Agent.TOOL_RESULT, {
          sessionId: request.sessionId,
          ...result,
        });
      },
      onAuthorizationRequired: (authRequest) => {
        // Send request to renderer and wait for response
        win.webContents.send(Channels.Agent.AUTHORIZATION_REQUEST, {
          sessionId: request.sessionId,
          ...authRequest,
        });
        return new Promise<AuthorizationResponse>((resolve) => {
          // Auto-reject after 5 minutes to prevent infinite hangs
          const timeoutId = setTimeout(
            () => {
              if (pendingAuthorizations.has(authRequest.toolCallId)) {
                pendingAuthorizations.delete(authRequest.toolCallId);
                logger.warn(`[Agent] Authorization timed out for ${authRequest.toolCallId}`);
                resolve({ approved: false, reason: '授权超时（5分钟未响应）' });
              }
            },
            5 * 60 * 1000,
          );

          pendingAuthorizations.set(authRequest.toolCallId, (response) => {
            clearTimeout(timeoutId);
            resolve(response);
          });
        });
      },
      onComplete: (finalMessage) => {
        win.webContents.send(Channels.Agent.COMPLETE, {
          sessionId: request.sessionId,
          finalMessage,
        });
      },
      onError: (error) => {
        win.webContents.send(Channels.Agent.ERROR, {
          sessionId: request.sessionId,
          message: error.message,
        });
      },
      onTodosUpdate: (todos) => {
        win.webContents.send(Channels.Agent.TODOS_UPDATE, {
          sessionId: request.sessionId,
          todos,
        });
      },
      onContextUsage: (event) => {
        win.webContents.send(Channels.Agent.CONTEXT_USAGE, event);
      },
      onPlanApproval: (plan) => {
        // Send plan to renderer for user approval, wait for response
        win.webContents.send(Channels.Agent.PLAN_APPROVAL_REQUEST, {
          sessionId: request.sessionId,
          plan,
        });
        return new Promise<PlanApprovalResult>((resolve) => {
          // Auto-reject after 10 minutes to prevent infinite hangs
          const timeoutId = setTimeout(
            () => {
              if (pendingPlanApprovals.has(request.sessionId)) {
                pendingPlanApprovals.delete(request.sessionId);
                logger.warn(`[Agent] Plan approval timed out for session ${request.sessionId}`);
                resolve({ approved: false, reason: 'Plan approval timed out (10 minutes)' });
              }
            },
            10 * 60 * 1000,
          );

          pendingPlanApprovals.set(request.sessionId, (result) => {
            clearTimeout(timeoutId);
            resolve(result);
          });
        });
      },
      onModeChange: (sessionId, newMode) => {
        // Notify renderer to update its safetyMode state (P0-1.B fix: state desync)
        win.webContents.send(Channels.Agent.MODE_CHANGE, { sessionId, mode: newMode });
      },
      onAskUser: (questions) => {
        // Send questions to renderer for user to answer, wait for response (P1-4)
        win.webContents.send(Channels.Agent.ASK_USER_REQUEST, {
          sessionId: request.sessionId,
          questions,
        });
        return new Promise<AskUserAnswer[]>((resolve) => {
          // Auto-dismiss after 10 minutes to prevent infinite hangs
          const timeoutId = setTimeout(
            () => {
              if (pendingAskUser.has(request.sessionId)) {
                pendingAskUser.delete(request.sessionId);
                logger.warn(`[Agent] Ask-user timed out for session ${request.sessionId}`);
                resolve([
                  {
                    question: questions[0]?.question ?? '',
                    answer: '(超时未响应)',
                    isOther: true,
                  },
                ]);
              }
            },
            10 * 60 * 1000,
          );

          pendingAskUser.set(request.sessionId, (answers) => {
            clearTimeout(timeoutId);
            resolve(answers);
          });
        });
      },
    })
      .catch((err) => {
        logger.error(`[Agent] Unhandled error in loop: ${err.message}`);
        win.webContents.send(Channels.Agent.ERROR, {
          sessionId: request.sessionId,
          message: err.message,
        });
      })
      .finally(() => {
        activeLoops.delete(request.sessionId);
      });
  });

  ipcMain.handle(Channels.Agent.CANCEL, async (_e, sessionId: string) => {
    // Trigger the AbortController so streamText stops yielding new chunks.
    // The loop preserves whatever text has already been streamed and calls
    // onComplete, so the renderer turns partial text into a saved assistant
    // message via its onComplete handler.
    const controller = activeLoops.get(sessionId);
    if (controller) {
      controller.abort();
      logger.info(`[Agent] Abort signal sent for session ${sessionId}`);
    } else {
      logger.warn(`[Agent] No active loop to cancel for session ${sessionId}`);
    }
  });

  ipcMain.handle(
    Channels.Agent.AUTHORIZATION_RESPONSE,
    async (_e, response: AgentAuthorizationResponse) => {
      const resolver = pendingAuthorizations.get(response.toolCallId);
      if (resolver) {
        pendingAuthorizations.delete(response.toolCallId);
        resolver({
          approved: response.approved,
          reason: response.reason,
          backup: response.backup,
        });
      } else {
        logger.warn(
          `[Agent] Authorization response for unknown toolCallId: ${response.toolCallId}`,
        );
      }
    },
  );

  // ---------- Plan Approval Response (P0-1.B) ----------
  ipcMain.handle(
    Channels.Agent.PLAN_APPROVAL_RESPONSE,
    async (_e, response: AgentPlanApprovalResponse) => {
      const resolver = pendingPlanApprovals.get(response.sessionId);
      if (resolver) {
        pendingPlanApprovals.delete(response.sessionId);
        resolver({
          approved: response.approved,
          editedPlan: response.editedPlan,
          reason: response.reason,
        });
      } else {
        logger.warn(`[Agent] Plan approval response for unknown session: ${response.sessionId}`);
      }
    },
  );

  // ---------- AskUser Response (P1-4) ----------
  ipcMain.handle(Channels.Agent.ASK_USER_RESPONSE, async (_e, response: AgentAskUserResponse) => {
    const resolver = pendingAskUser.get(response.sessionId);
    if (resolver) {
      pendingAskUser.delete(response.sessionId);
      // If the user dismissed the dialog, response.answers contains
      // placeholder entries with answer='(用户取消)' set by the renderer.
      resolver(response.answers);
    } else {
      logger.warn(`[Agent] Ask-user response for unknown session: ${response.sessionId}`);
    }
  });

  // ---------- Context: Manual Compact ----------
  ipcMain.handle(Channels.Agent.COMPACT, async (_e, sessionId: string, _instructions?: string) => {
    const messages = loadMessages(sessionId);
    if (messages.length < 5) {
      return {
        ok: false,
        reason: 'too_few_messages',
        messageCount: messages.length,
      };
    }
    const model = getActiveModel();
    if (!model) {
      return { ok: false, reason: 'no_model' };
    }
    const compressed = await compressContext(messages, {
      sessionId,
      model,
      force: true,
    });
    // Return summary info so the renderer can show a system message.
    const summaryMsg = compressed.find(
      (m) =>
        m.role === 'system' && typeof m.content === 'string' && m.content.includes('上下文摘要'),
    );
    const summaryText = typeof summaryMsg?.content === 'string' ? summaryMsg.content : '';
    return {
      ok: true,
      messageCount: messages.length,
      compressedCount: compressed.length,
      summary: summaryText,
    };
  });

  // ---------- Context: Breakdown (/context command) ----------
  ipcMain.handle(Channels.Agent.GET_CONTEXT, async (_e, sessionId: string) => {
    const model = getActiveModel();
    const modelId = model?.modelId ?? 'unknown';
    return analyzeContextBreakdown(sessionId, modelId);
  });

  // ---------- Quick Command (> / $ prefix) ----------
  // Directly executes a shell command via SSH without going through the AI
  // agent loop. Prevents the bug where ">ls @test" was sent as a chat
  // message and the AI interpreted it as a work request.
  ipcMain.handle(
    Channels.Agent.QUICK_COMMAND,
    async (_e, _sessionId: string, command: string, hostName?: string) => {
      try {
        // Resolve host
        let host;
        if (hostName) {
          host = hostsStore.getByName(hostName);
        } else {
          // Use the first available host if none specified
          const allHosts = hostsStore.list();
          host = allHosts[0] ?? null;
        }
        if (!host) {
          return {
            ok: false,
            error: hostName ? `主机 '${hostName}' 不存在` : '未配置任何主机',
          };
        }

        const manager = await connectionPool.get(host.id);
        const result = await execCommand(manager, command);
        return {
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          hostName: host.name,
          command,
        };
      } catch (err) {
        return {
          ok: false,
          error: (err as Error).message,
          command,
          hostName,
        };
      }
    },
  );

  // ---------- Skills ----------
  ipcMain.handle(Channels.Skills.LIST, async () => {
    const all = listAllSkills();
    const enabled = new Set(getEnabledSkills().map((s) => s.name));
    return all.map((s) => ({
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      whenToUse: s.whenToUse,
      source: s.source,
      enabled: enabled.has(s.name),
      enabledByDefault: s.enabledByDefault,
      filePath: s.filePath,
    }));
  });

  ipcMain.handle(Channels.Skills.GET_CONTENT, async (_e, name: string) => {
    return getSkillContent(name);
  });

  ipcMain.handle(
    Channels.Skills.INSTALL,
    async (_e, name: string, content: string, description?: string, whenToUse?: string) => {
      return installSkill(name, content, description, whenToUse);
    },
  );

  ipcMain.handle(Channels.Skills.DELETE, async (_e, name: string) => {
    return deleteSkill(name);
  });

  ipcMain.handle(Channels.Skills.TOGGLE, async (_e, name: string, enabled: boolean) => {
    setSkillEnabled(name, enabled);
  });

  // ---------- Tasks (TodoWrite) ----------
  ipcMain.handle(Channels.Tasks.LIST, async (_e, sessionId: string) => {
    return taskListsStore.get(sessionId) ?? [];
  });

  ipcMain.handle(Channels.Tasks.UPDATE, async (_e, sessionId: string, todos: TodoItem[]) => {
    taskListsStore.save(sessionId, todos);
    return { success: true };
  });

  // ---------- Window ----------
  // Restores OS-level keyboard focus to the BrowserWindow. Needed because
  // some Electron renderer APIs (e.g. window.focus()) cannot bypass the
  // Win32 foreground lock. The main process has the authority to call
  // SetForegroundWindow via BrowserWindow.focus().
  ipcMain.handle(Channels.Window.RESTORE_FOCUS, async () => {
    if (mainWindow) {
      mainWindow.focus();
      mainWindow.webContents.focus();
    }
  });

  logger.info('IPC handlers registered');

  // Register terminal IPC handlers (interactive SSH shell sessions)
  registerTerminalHandlers(win);
}

// Clean up all terminal sessions on app exit
export function cleanupTerminalSessions(): void {
  closeAllTerminals();
}
