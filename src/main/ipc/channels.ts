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
  Agent: {
    RUN: 'agent:run',
    CANCEL: 'agent:cancel',
    // Events: main → renderer (via webContents.send)
    TEXT_STREAM: 'agent:text-stream',
    TOOL_CALL: 'agent:tool-call',
    TOOL_RESULT: 'agent:tool-result',
    AUTHORIZATION_REQUEST: 'agent:authorization-request',
    COMPLETE: 'agent:complete',
    ERROR: 'agent:error',
    // Handler: renderer → main (via ipcMain.handle)
    AUTHORIZATION_RESPONSE: 'agent:authorization-response',
  },
} as const;

export type ChannelName = string;
