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
  },
  Models: {
    LIST: 'models:list',
    CREATE: 'models:create',
    UPDATE: 'models:update',
    DELETE: 'models:delete',
    SET_ACTIVE: 'models:setActive',
    GET_ACTIVE: 'models:getActive',
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
  },
  Audit: {
    LIST: 'audit:list',
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
  },
  Agent: {
    RUN: 'agent:run',
    CANCEL: 'agent:cancel',
    COMPACT: 'agent:compact',
    GET_CONTEXT: 'agent:getContext',
    QUICK_COMMAND: 'agent:quick-command',
    // Events: main -> renderer (via webContents.send)
    TEXT_STREAM: 'agent:text-stream',
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
    // Handler: renderer -> main (via ipcMain.handle)
    AUTHORIZATION_RESPONSE: 'agent:authorization-response',
    PLAN_APPROVAL_RESPONSE: 'agent:plan-approval-response',
    ASK_USER_RESPONSE: 'agent:ask-user-response',
  },
  Tasks: {
    LIST: 'tasks:list',
    UPDATE: 'tasks:update',
  },
  Window: {
    RESTORE_FOCUS: 'window:restoreFocus',
  },
} as const;

export type ChannelName = string;
