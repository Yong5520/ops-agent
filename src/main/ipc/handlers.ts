import { ipcMain, shell, BrowserWindow } from 'electron';
import { Channels } from './channels.js';
import { createCancellablePending } from './cancellable-pending.js';
import { logger } from '../utils/logger.js';
import { hostsStore } from '../storage/hosts.js';
import { modelsStore } from '../storage/models.js';
import { sessionsStore } from '../storage/sessions.js';
import { auditStore } from '../storage/audit.js';
import { settingsStore } from '../storage/settings.js';
import { customRulesStore } from '../storage/custom-rules.js';
import {
  loadSecurityRulesConfig,
  resetToFactoryDefaults,
  reloadSecurityRulesConfig,
  getRulesFilePath,
} from '../security/rules-config.js';
import { hooksStore } from '../storage/hooks.js';
import { taskListsStore } from '../storage/task-lists.js';
import { runAgentLoop } from '../agent/loop.js';
import { resolveQuickCommandHost } from '../agent/quick-command-host.js';
import { activityMirrorSubscribe, activityMirrorHistory } from '../agent/activity-mirror.js';
import { mirrorEventTargets } from './mirror-routing.js';
import { createActivityMirrorWindow, getActivityMirrorWindowIds } from '../window-manager.js';
import { exportSessionToMarkdown } from '../agent/export.js';
import {
  clearSummaryCache,
  compressContext,
  loadMessages,
  saveUserMessage,
} from '../agent/context.js';
import { cleanupSessionResults } from '../agent/tool-results.js';
import { analyzeContextBreakdown } from '../agent/context-breakdown.js';
import { attachmentsStore } from '../storage/attachments.js';
import { getDb } from '../storage/database.js';
import { getSessionCostTotal } from '../storage/cost-store.js';
import {
  listAllSkills,
  getEnabledSkills,
  getSkillContent,
  installSkill,
  deleteSkill,
  setSkillEnabled,
  listSkillFiles,
  readSkillFile,
  writeSkillFile,
  deleteSkillFile,
  importSkillFromDirectory,
  type SkillFileInput,
} from '../agent/skills/index.js';
import {
  createLanguageModel,
  resolveModelProvider,
  resolveTestTarget,
  testProviderConnection,
} from '../agent/providers.js';
import { connectionPool, execCommand } from '../ssh/index.js';
import { abortRunningCommand } from '../ssh/running-command-registry.js';
import { registerTerminalHandlers, closeAllTerminals } from './terminal.js';
import type { AuthorizationResponse } from '../agent/types.js';
import type {
  AgentRunRequest,
  AgentAuthorizationResponse,
  AgentPlanApprovalResponse,
  AgentAskUserResponse,
} from './preload-api.js';
import type { TodoItem, ModelProviderInput, SteerEntry } from '../../shared/types.js';
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

// Phase 3: queued steer messages keyed by sessionId. The user types mid-run to
// redirect the task; the agent loop drains these (consumeSteerMessages) before
// the next streamText round and injects each entry's text as a user message.
// Each entry carries the renderer-assigned msgId so onSteerConsumed can report
// back exactly which queued steers were fed to the model.
const pendingSteerMessages = new Map<string, SteerEntry[]>();

// Active agent loops keyed by sessionId. Each entry holds the AbortController
// used to genuinely terminate the streaming loop when the user clicks Stop.
const activeLoops = new Map<string, AbortController>();

let mainWindow: BrowserWindow | null = null;

/** Ids of all currently-alive BrowserWindows (mirror event fan-out). */
function allAliveWindowIds(): Set<number> {
  const ids = new Set<number>();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) ids.add(win.id);
  }
  return ids;
}

export function registerIpcHandlers(win: BrowserWindow): void {
  mainWindow = win;

  // v24 activity mirror: fan raw-channel mirror events out to every window
  // that renders them (the main window's side panel + any open activity
  // windows). Deduplicate by window id; a destroyed window's send is skipped.
  activityMirrorSubscribe((event) => {
    const targets = mirrorEventTargets({
      mainWindowId: mainWindow?.id ?? -1,
      mirrorWindowIds: getActivityMirrorWindowIds(),
      allWindowIds: allAliveWindowIds(),
    });
    for (const id of targets) {
      const target = BrowserWindow.fromId(id);
      if (target && !target.isDestroyed()) {
        target.webContents.send(Channels.Agent.MIRROR_EVENT, event);
      }
    }
  });

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
  ipcMain.handle(Channels.Hosts.CREATE_GROUP, async (_e, name: string) =>
    hostsStore.createGroup(name),
  );
  ipcMain.handle(Channels.Hosts.CLEAR_HOST_KEY, async (_e, id: string) => {
    // V3-10: clear the stored fingerprint (null) and invalidate the cached
    // connection so the next connect re-runs TOFU with the server's current
    // key. Recovers from a stale fingerprint after a host re-key or address
    // change without requiring the user to edit the DB directly.
    hostsStore.setHostKeyFingerprint(id, null);
    connectionPool.invalidate(id);
    return hostsStore.get(id);
  });

  // ---------- Models ----------
  ipcMain.handle(Channels.Models.LIST, async () => modelsStore.list());
  ipcMain.handle(Channels.Models.CREATE, async (_e, payload) => modelsStore.create(payload));
  ipcMain.handle(Channels.Models.UPDATE, async (_e, id: string, payload) =>
    modelsStore.update(id, payload),
  );
  ipcMain.handle(Channels.Models.DELETE, async (_e, id: string) => modelsStore.delete(id));
  ipcMain.handle(Channels.Models.SET_ACTIVE, async (_e, id: string) => modelsStore.setActive(id));
  ipcMain.handle(Channels.Models.GET_ACTIVE, async () => modelsStore.getActive());
  // Test a provider config without saving it. Accepts the form input and an
  // optional id (for the edit flow, where a blank apiKey falls back to the
  // stored key via resolveTestProvider). Never throws - returns {ok,error}.
  //
  // CRITICAL: read the stored row via getWithSecret(id), NOT get(id). get()
  // strips the apiKey (secrets are kept out of the renderer-facing layer);
  // getWithSecret() decrypts it. Using get() here caused "API key is missing"
  // failures on the test button even though chat worked (chat uses
  // getActive(), which also decrypts).
  ipcMain.handle(
    Channels.Models.TEST_CONNECTION,
    async (_e, input: ModelProviderInput | null, id?: string) => {
      try {
        const stored = id ? modelsStore.getWithSecret(id) : null;
        const toTest = resolveTestTarget(input, stored);
        if (!toTest) {
          return {
            ok: false,
            error: '未提供 API Key，且未找到已保存的配置。请填写 API Key 后重试。',
          };
        }
        if (!toTest.apiKey) {
          return {
            ok: false,
            error: '未配置 API Key。请在编辑模型时填写 API Key 后保存，再测试连接。',
          };
        }
        return await testProviderConnection(toTest);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

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
    // save messages to a session that no longer exists. The abort also
    // resolves any pending authorization / ask_user / plan-approval promise
    // for this session (via createCancellablePending) and removes it from the
    // pending maps, so no orphaned resolver lingers for the deleted session.
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
  // Cumulative token usage + estimated USD for a session (V3-01). Powers the
  // /cost slash command - a zero-LLM path so users can check usage without the
  // agent misreading the question as a host task.
  ipcMain.handle(Channels.Sessions.COST_TOTAL, async (_e, sessionId: string) =>
    getSessionCostTotal(sessionId),
  );
  // V3-07 Cycle C: stop a single in-flight tool command (e.g. tail -f) by
  // toolCallId. Returns { stopped: boolean }. Bridges to the global registry.
  ipcMain.handle(Channels.Agent.STOP_TOOL, async (_e, toolCallId: string) => ({
    stopped: abortRunningCommand(toolCallId),
  }));
  ipcMain.handle(
    Channels.Sessions.DELETE_MESSAGES_AFTER,
    async (_e, sessionId: string, messageId: string) =>
      sessionsStore.deleteMessagesAfter(sessionId, messageId),
  );

  // ---------- Audit ----------
  ipcMain.handle(Channels.Audit.LIST, async (_e, filter) => auditStore.list(filter));
  ipcMain.handle(Channels.Audit.COUNT, async (_e, filter) => auditStore.count(filter));
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

  // ---------- Security config file (user-editable default rules) ----------
  // The default blocked/allowed rule set lives in {userData}/security-rules.json.
  // These handlers let the Settings UI show the path, open the file for
  // editing, reload after an edit, and reset to factory defaults.
  ipcMain.handle(Channels.SecurityConfig.GET_FILE_PATH, async () => getRulesFilePath());
  ipcMain.handle(Channels.SecurityConfig.OPEN_FILE, async () => {
    const filePath = getRulesFilePath();
    if (!filePath) return { ok: false, error: '路径不可用' };
    const err = await shell.openPath(filePath);
    return { ok: !err, error: err || undefined, path: filePath };
  });
  ipcMain.handle(Channels.SecurityConfig.RELOAD, async () => {
    reloadSecurityRulesConfig();
    return loadSecurityRulesConfig({ force: true });
  });
  ipcMain.handle(Channels.SecurityConfig.RESET, async () => {
    resetToFactoryDefaults();
    return loadSecurityRulesConfig({ force: true });
  });
  ipcMain.handle(Channels.SecurityConfig.LIST, async () =>
    loadSecurityRulesConfig({ force: true }),
  );

  // ---------- Hooks ----------
  ipcMain.handle(Channels.Hooks.LIST, async () => hooksStore.list());
  ipcMain.handle(Channels.Hooks.CREATE, async (_e, payload) => hooksStore.create(payload));
  ipcMain.handle(Channels.Hooks.UPDATE, async (_e, id: string, payload) =>
    hooksStore.update(id, payload),
  );
  ipcMain.handle(Channels.Hooks.DELETE, async (_e, id: string) => hooksStore.delete(id));

  // ---------- Agent ----------
  // v24 activity mirror: replay buffered history (scoped to a session and
  // host bucket) so a newly-opened mirror window shows past activity.
  ipcMain.handle(
    Channels.Agent.MIRROR_HISTORY,
    async (_e, sessionId: string | undefined, hostId: string | undefined) => {
      return activityMirrorHistory(sessionId, hostId);
    },
  );

  // v24 activity mirror: open a standalone read-only mirror window.
  ipcMain.handle(Channels.Agent.MIRROR_OPEN_WINDOW, async (_e, sessionId?: string) => {
    createActivityMirrorWindow(sessionId);
    return { ok: true };
  });

  ipcMain.handle(Channels.Agent.RUN, async (_e, request: AgentRunRequest) => {
    if (!mainWindow) {
      throw new Error('Main window not available');
    }
    if (activeLoops.has(request.sessionId)) {
      throw new Error(`Agent loop already running for session ${request.sessionId}`);
    }

    const abortController = new AbortController();
    activeLoops.set(request.sessionId, abortController);
    // Phase 3: discard any stale steer messages queued by a previous run (e.g.
    // a steer that arrived in the residual window after the prior loop exited
    // but before activeLoops was cleared). They were already persisted to the
    // DB by the steer handler, so loadMessages will pick them up as history -
    // dropping the queue entries here prevents the model from seeing them twice.
    pendingSteerMessages.delete(request.sessionId);
    const win = mainWindow;

    // Run the loop asynchronously — the handler returns immediately after
    // starting. All output flows via events (text-stream, tool-call, etc.).
    runAgentLoop({
      sessionId: request.sessionId,
      userMessage: request.userMessage,
      hostIds: request.hostIds,
      safetyMode: request.safetyMode,
      // Per-session model override (undefined = use session/global default).
      modelProviderId: request.modelProviderId,
      maxSteps: request.maxSteps,
      attachments: request.attachments,
      abortSignal: abortController.signal,
      onTextStream: (text) => {
        win.webContents.send(Channels.Agent.TEXT_STREAM, {
          sessionId: request.sessionId,
          text,
        });
      },
      onThinkingStream: (event) => {
        win.webContents.send(Channels.Agent.THINKING_STREAM, {
          sessionId: request.sessionId,
          ...event,
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
        // Abortable + race-safe: resolves on user response, abort (Stop), or
        // 5-min idle timeout. Previously a bare Promise that ignored the abort
        // signal, so clicking Stop left the loop blocked here for 5 minutes.
        return createCancellablePending<AuthorizationResponse>({
          map: pendingAuthorizations,
          key: authRequest.toolCallId,
          signal: abortController.signal,
          timeoutMs: 5 * 60 * 1000,
          onTimeout: () => {
            logger.warn(`[Agent] Authorization timed out for ${authRequest.toolCallId}`);
            return { approved: false, reason: '授权超时（5分钟未响应）' };
          },
          onAbort: () => ({ approved: false, reason: '已取消' }),
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
        // Abortable + race-safe (keyed by sessionId). Previously a bare Promise
        // that ignored the abort signal and whose timeout could delete a newer
        // run's entry (the 1d race).
        return createCancellablePending<PlanApprovalResult>({
          map: pendingPlanApprovals,
          key: request.sessionId,
          signal: abortController.signal,
          timeoutMs: 10 * 60 * 1000,
          onTimeout: () => {
            logger.warn(`[Agent] Plan approval timed out for session ${request.sessionId}`);
            return { approved: false, reason: 'Plan approval timed out (10 minutes)' };
          },
          onAbort: () => ({ approved: false, reason: '已取消' }),
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
        // Abortable + race-safe (keyed by sessionId). Previously a bare Promise
        // that ignored the abort signal - clicking Stop during an ask_user left
        // the loop blocked for up to 10 minutes (issues 1 & 2 root cause).
        return createCancellablePending<AskUserAnswer[]>({
          map: pendingAskUser,
          key: request.sessionId,
          signal: abortController.signal,
          timeoutMs: 10 * 60 * 1000,
          onTimeout: () => {
            logger.warn(`[Agent] Ask-user timed out for session ${request.sessionId}`);
            return [
              {
                question: questions[0]?.question ?? '',
                answer: '(超时未响应)',
                isOther: true,
              },
            ];
          },
          onAbort: () => [
            {
              question: questions[0]?.question ?? '',
              answer: '(已取消)',
              isOther: true,
            },
          ],
        });
      },
      consumeSteerMessages: () => {
        // Drain the per-session steer queue (returns + clears). The loop calls
        // this before each streamText round and once at exit so mid-run user
        // input is injected as user messages.
        const queued = pendingSteerMessages.get(request.sessionId);
        if (!queued || queued.length === 0) return [];
        pendingSteerMessages.delete(request.sessionId);
        return queued;
      },
      onSteerConsumed: (entries) => {
        // The loop drained these queued steers and will feed them to the model
        // on the next round. Notify the renderer so it can move them from the
        // pending queue into the message list at the right moment (after the
        // current response, before the next one). The steers were already
        // persisted when queued, so this only signals the UI transition.
        if (entries.length === 0) return;
        win.webContents.send(Channels.Agent.STEER_CONSUMED, {
          sessionId: request.sessionId,
          msgIds: entries.map((e) => e.msgId),
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
      // Firing the AbortController resolves every pending authorization /
      // ask_user / plan-approval promise for this session (via
      // createCancellablePending's abort listener) with a cancellation value,
      // and removes them from the pending maps. This is what lets
      // runAgentLoop settle promptly so activeLoops is freed - previously the
      // loop stayed blocked on an unabortable ask_user for up to 10 minutes
      // and the next run threw "Agent loop already running".
    } else {
      logger.warn(`[Agent] No active loop to cancel for session ${sessionId}`);
    }
  });

  ipcMain.handle(
    Channels.Agent.STEER,
    async (_e, request: { sessionId: string; message: string; msgId: string }) => {
      // Phase 3: enqueue a steer message the user typed mid-run to redirect the
      // task. Persist it immediately so it is never lost (even if the loop exits
      // before draining the queue, the next run's loadMessages picks it up). If a
      // loop is active, queue it for the loop to drain before the next round; if
      // not, the saved message stands as the latest user turn for the next run.
      // The renderer-assigned msgId flows back via agent:steer-consumed so the UI
      // can move the queued bubble into the message list when the model sees it.
      const { sessionId, message, msgId } = request;
      const trimmed = message?.trim();
      if (!trimmed) return;
      try {
        saveUserMessage(sessionId, trimmed);
      } catch (err) {
        logger.error(`[Agent] Failed to persist steer message: ${(err as Error).message}`);
      }
      if (activeLoops.has(sessionId)) {
        const queue = pendingSteerMessages.get(sessionId) ?? [];
        queue.push({ msgId, text: trimmed });
        pendingSteerMessages.set(sessionId, queue);
        logger.info(`[Agent] Steer message queued for session ${sessionId}`);
      } else {
        logger.warn(
          `[Agent] Steer for session ${sessionId} with no active loop; saved as pending user turn`,
        );
      }
    },
  );

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
          editedCommand: response.editedCommand,
          stopRequested: response.stopRequested,
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
    // Per-session override wins over the global default (same resolution as
    // the agent loop). resolveModelProvider throws when no model is configured;
    // map that to the 'no_model' result the renderer already handles (and which
    // the previous getActiveModel() throw never actually reached).
    const model = (() => {
      try {
        return createLanguageModel(resolveModelProvider(sessionId));
      } catch (err) {
        logger.warn(
          `[Agent] Compact aborted - no model for session ${sessionId}: ${(err as Error).message}`,
        );
        return null;
      }
    })();
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
    // Resolve the session's model (per-session override -> global default).
    // If none is configured, resolveModelProvider throws - fall back to an
    // 'unknown' model with no context-window override so /context still shows
    // a breakdown rather than an IPC rejection (renderer expects an object).
    let modelId = 'unknown';
    let contextWindowOverride: number | undefined;
    try {
      const provider = resolveModelProvider(sessionId);
      const model = createLanguageModel(provider);
      modelId = model.modelId;
      contextWindowOverride = provider.contextWindow;
    } catch (err) {
      logger.warn(
        `[Agent] /context for session ${sessionId} - no model: ${(err as Error).message}`,
      );
    }
    return analyzeContextBreakdown(sessionId, modelId, contextWindowOverride);
  });

  // ---------- Quick Command (> / $ prefix) ----------
  // Directly executes a shell command via SSH without going through the AI
  // agent loop. Prevents the bug where ">ls @test" was sent as a chat
  // message and the AI interpreted it as a work request.
  ipcMain.handle(
    Channels.Agent.QUICK_COMMAND,
    async (_e, sessionId: string, command: string, hostName?: string) => {
      try {
        // Resolve host. v24: without an explicit @host, run on the session's
        // first selected host - never silently fall back to the first host
        // in the DB (that executed commands on an arbitrary machine).
        const session = sessionsStore.getSession(sessionId);
        const host = resolveQuickCommandHost(hostName, session?.hostIds, hostsStore.list());
        if (!host) {
          return {
            ok: false,
            error: hostName
              ? `主机 '${hostName}' 不存在`
              : '未选择目标主机，请先在会话侧边栏勾选目标主机（或使用 @主机名 指定）',
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
      scriptCount: s.scripts.length,
      referenceCount: s.references.length,
      assetCount: s.assets.length,
    }));
  });

  ipcMain.handle(Channels.Skills.GET_CONTENT, async (_e, name: string) => {
    return getSkillContent(name);
  });

  ipcMain.handle(
    Channels.Skills.INSTALL,
    async (
      _e,
      name: string,
      content: string,
      description?: string,
      whenToUse?: string,
      files?: SkillFileInput[],
    ) => {
      return installSkill(name, content, description, whenToUse, files);
    },
  );

  ipcMain.handle(Channels.Skills.DELETE, async (_e, name: string) => {
    return deleteSkill(name);
  });

  ipcMain.handle(Channels.Skills.TOGGLE, async (_e, name: string, enabled: boolean) => {
    setSkillEnabled(name, enabled);
  });

  ipcMain.handle(Channels.Skills.LIST_FILES, async (_e, name: string) => {
    return listSkillFiles(name);
  });

  ipcMain.handle(Channels.Skills.READ_FILE, async (_e, name: string, filePath: string) => {
    return readSkillFile(name, filePath);
  });

  ipcMain.handle(
    Channels.Skills.WRITE_FILE,
    async (_e, name: string, filePath: string, content: string) => {
      return writeSkillFile(name, filePath, content);
    },
  );

  ipcMain.handle(Channels.Skills.DELETE_FILE, async (_e, name: string, filePath: string) => {
    return deleteSkillFile(name, filePath);
  });

  ipcMain.handle(
    Channels.Skills.IMPORT_FROM_DIR,
    async (_e, srcPath: string, skillName?: string) => {
      return importSkillFromDirectory(srcPath, skillName);
    },
  );

  // ---------- Tasks (TodoWrite) ----------
  ipcMain.handle(Channels.Tasks.LIST, async (_e, sessionId: string) => {
    return taskListsStore.get(sessionId) ?? [];
  });

  ipcMain.handle(Channels.Tasks.UPDATE, async (_e, sessionId: string, todos: TodoItem[]) => {
    taskListsStore.save(sessionId, todos);
    return { success: true };
  });

  // ---------- Attachments (image file reading) ----------
  // Returns a single attachment's image data as a base64 data URL so the
  // renderer can render it in <img> tags without direct file system access.
  ipcMain.handle(Channels.Attachments.READ, async (_e, attachmentId: string) => {
    const db = getDb();
    const row = db
      .prepare('SELECT file_path, mime_type FROM message_attachments WHERE id = ?')
      .get(attachmentId) as { file_path: string; mime_type: string } | undefined;
    if (!row) return null;
    return attachmentsStore.readAsDataUrl(row.file_path, row.mime_type);
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
