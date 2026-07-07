import { ipcMain, type BrowserWindow } from 'electron';
import { Channels } from './channels.js';
import { logger } from '../utils/logger.js';
import { hostsStore } from '../storage/hosts.js';
import { modelsStore } from '../storage/models.js';
import { sessionsStore } from '../storage/sessions.js';
import { auditStore } from '../storage/audit.js';
import { settingsStore } from '../storage/settings.js';
import { customRulesStore } from '../storage/custom-rules.js';
import { runAgentLoop } from '../agent/loop.js';
import { exportSessionToMarkdown } from '../agent/export.js';
import { connectionPool } from '../ssh/index.js';
import type { AuthorizationResponse } from '../agent/types.js';
import type { AgentRunRequest, AgentAuthorizationResponse } from './preload-api.js';

// Register all IPC handlers between renderer and main.
// Called once from electron/main.ts during app.whenReady().
// The mainWindow is needed for agent events (main → renderer streaming).

// Pending authorization requests keyed by toolCallId.
// When the agent loop requests authorization, we store a resolver here.
// When the renderer responds via 'agent:authorization-response', we resolve.
const pendingAuthorizations = new Map<string, (response: AuthorizationResponse) => void>();

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
  ipcMain.handle(Channels.Sessions.DELETE, async (_e, id: string) =>
    sessionsStore.deleteSession(id),
  );
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

  logger.info('IPC handlers registered');
}
