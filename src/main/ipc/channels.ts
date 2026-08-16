// Centralized IPC channel names to avoid typo drift between main and preload.

export const Channels = {
  System: {
    PING: 'system:ping',
  },
  Hosts: {
    LIST: 'hosts:list',
    GET: 'hosts:get',
    CREATE: 'hosts:create',
    UPDATE: 'hosts:update',
    DELETE: 'hosts:delete',
    TEST_CONNECTION: 'hosts:testConnection',
    LIST_STATUS: 'hosts:listStatus',
    BATCH_CREATE: 'hosts:batchCreate',
    RENAME_GROUP: 'hosts:renameGroup',
    DELETE_GROUP: 'hosts:deleteGroup',
    LIST_GROUPS: 'hosts:listGroups',
    CREATE_GROUP: 'hosts:createGroup',
    // V3-10: clear a stale stored host_key_fingerprint so the next connect
    // re-runs TOFU (recover from "Host denied (verification failed)").
    CLEAR_HOST_KEY: 'hosts:clearHostKey',
  },
  Models: {
    LIST: 'models:list',
    CREATE: 'models:create',
    UPDATE: 'models:update',
    DELETE: 'models:delete',
    SET_ACTIVE: 'models:setActive',
    GET_ACTIVE: 'models:getActive',
    TEST_CONNECTION: 'models:testConnection',
  },
  Sessions: {
    LIST: 'sessions:list',
    GET: 'sessions:get',
    CREATE: 'sessions:create',
    UPDATE: 'sessions:update',
    DELETE: 'sessions:delete',
    MESSAGES: 'sessions:messages',
    ADD_MESSAGE: 'sessions:addMessage',
    DELETE_MESSAGES_AFTER: 'sessions:deleteMessagesAfter',
    EXPORT: 'sessions:export',
    COST_TOTAL: 'sessions:costTotal',
  },
  Audit: {
    LIST: 'audit:list',
    COUNT: 'audit:count',
    CREATE: 'audit:create',
    VERIFY: 'audit:verify',
  },
  Settings: {
    GET: 'settings:get',
    SET: 'settings:set',
    GET_ALL: 'settings:getAll',
  },
  Rules: {
    LIST: 'rules:list',
    CREATE: 'rules:create',
    UPDATE: 'rules:update',
    DELETE: 'rules:delete',
  },
  SecurityConfig: {
    // User-editable security rules config file ({userData}/security-rules.json)
    GET_FILE_PATH: 'securityConfig:getFilePath',
    OPEN_FILE: 'securityConfig:openFile',
    RELOAD: 'securityConfig:reload',
    RESET: 'securityConfig:reset',
    LIST: 'securityConfig:list',
  },
  Hooks: {
    LIST: 'hooks:list',
    CREATE: 'hooks:create',
    UPDATE: 'hooks:update',
    DELETE: 'hooks:delete',
  },
  Skills: {
    LIST: 'skills:list',
    GET_CONTENT: 'skills:getContent',
    INSTALL: 'skills:install',
    DELETE: 'skills:delete',
    TOGGLE: 'skills:toggle',
    LIST_FILES: 'skills:listFiles',
    READ_FILE: 'skills:readFile',
    WRITE_FILE: 'skills:writeFile',
    DELETE_FILE: 'skills:deleteFile',
    IMPORT_FROM_DIR: 'skills:importFromDir',
  },
  Agent: {
    RUN: 'agent:run',
    CANCEL: 'agent:cancel',
    COMPACT: 'agent:compact',
    GET_CONTEXT: 'agent:getContext',
    QUICK_COMMAND: 'agent:quick-command',
    // Events: main -> renderer (via webContents.send)
    TEXT_STREAM: 'agent:text-stream',
    THINKING_STREAM: 'agent:thinking-stream',
    TOOL_CALL: 'agent:tool-call',
    TOOL_RESULT: 'agent:tool-result',
    AUTHORIZATION_REQUEST: 'agent:authorization-request',
    COMPLETE: 'agent:complete',
    ERROR: 'agent:error',
    TODOS_UPDATE: 'agent:todos-update',
    CONTEXT_USAGE: 'agent:context-usage',
    // Plan approval (P0-1.B)
    PLAN_APPROVAL_REQUEST: 'agent:plan-approval-request',
    MODE_CHANGE: 'agent:mode-change',
    // AskUserQuestion (P1-4)
    ASK_USER_REQUEST: 'agent:ask-user-request',
    // V3-07 Cycle C: stop a single in-flight tool command by toolCallId
    // (e.g. a running tail -f). Bridges to runningCommands.abort.
    STOP_TOOL: 'agent:stop-tool',
    // Phase 3: enqueue a steer message typed mid-run to redirect the task.
    // The loop drains the queue (consumeSteerMessages) before the next round.
    STEER: 'agent:steer',
    // Phase 3: main -> renderer notification that queued steers were drained
    // (fed to the model), so the UI can move them from the pending queue into
    // the message list at the right moment.
    STEER_CONSUMED: 'agent:steer-consumed',
    // Handler: renderer -> main (via ipcMain.handle)
    AUTHORIZATION_RESPONSE: 'agent:authorization-response',
    PLAN_APPROVAL_RESPONSE: 'agent:plan-approval-response',
    ASK_USER_RESPONSE: 'agent:ask-user-response',
    // v24 activity mirror: renderer -> main, fetch buffered mirror history
    // (for replay when a mirror window opens mid-run).
    MIRROR_HISTORY: 'agent:mirror-history',
    // v24 activity mirror: main -> renderer, live raw-channel mirror events.
    MIRROR_EVENT: 'agent:mirror-event',
    // v24 activity mirror: renderer -> main, open a standalone mirror window.
    MIRROR_OPEN_WINDOW: 'agent:mirror-open-window',
  },
  Tasks: {
    LIST: 'tasks:list',
    UPDATE: 'tasks:update',
  },
  Attachments: {
    READ: 'attachments:read',
  },
  Window: {
    RESTORE_FOCUS: 'window:restoreFocus',
  },
  Serial: {
    // Enumerate local serial ports (COMx / ttyUSB*) for the host-config picker.
    LIST_PORTS: 'serial:listPorts',
  },
} as const;

export type ChannelName = string;
