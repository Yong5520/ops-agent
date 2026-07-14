import { contextBridge, ipcRenderer } from 'electron';
import type { OpsAgentApi } from '../src/main/ipc/preload-api.js';

const api: OpsAgentApi = {
  // System
  ping: () => ipcRenderer.invoke('system:ping'),

  // Hosts
  hosts: {
    list: () => ipcRenderer.invoke('hosts:list'),
    get: (id: string) => ipcRenderer.invoke('hosts:get', id),
    create: (payload) => ipcRenderer.invoke('hosts:create', payload),
    update: (id, payload) => ipcRenderer.invoke('hosts:update', id, payload),
    remove: (id: string) => ipcRenderer.invoke('hosts:delete', id),
    testConnection: (id: string) => ipcRenderer.invoke('hosts:testConnection', id),
    listStatus: () => ipcRenderer.invoke('hosts:listStatus'),
    batchCreate: (payloads) => ipcRenderer.invoke('hosts:batchCreate', payloads),
    renameGroup: (oldName: string, newName: string) =>
      ipcRenderer.invoke('hosts:renameGroup', oldName, newName),
    deleteGroup: (groupName: string) => ipcRenderer.invoke('hosts:deleteGroup', groupName),
    listGroups: () => ipcRenderer.invoke('hosts:listGroups'),
  },

  // Models
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    create: (payload) => ipcRenderer.invoke('models:create', payload),
    update: (id, payload) => ipcRenderer.invoke('models:update', id, payload),
    remove: (id: string) => ipcRenderer.invoke('models:delete', id),
    setActive: (id: string) => ipcRenderer.invoke('models:setActive', id),
    getActive: () => ipcRenderer.invoke('models:getActive'),
  },

  // Sessions
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    get: (id: string) => ipcRenderer.invoke('sessions:get', id),
    create: (payload) => ipcRenderer.invoke('sessions:create', payload),
    update: (id, payload) => ipcRenderer.invoke('sessions:update', id, payload),
    remove: (id: string) => ipcRenderer.invoke('sessions:delete', id),
    messages: (sessionId: string) => ipcRenderer.invoke('sessions:messages', sessionId),
    addMessage: (payload) => ipcRenderer.invoke('sessions:addMessage', payload),
    deleteMessagesAfter: (sessionId: string, messageId: string) =>
      ipcRenderer.invoke('sessions:deleteMessagesAfter', sessionId, messageId),
    export: (sessionId: string) => ipcRenderer.invoke('sessions:export', sessionId),
  },

  // Audit
  audit: {
    list: (filter) => ipcRenderer.invoke('audit:list', filter),
    create: (payload) => ipcRenderer.invoke('audit:create', payload),
    verifyIntegrity: () => ipcRenderer.invoke('audit:verify'),
  },

  // Settings
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
  },

  // Custom rules
  rules: {
    list: () => ipcRenderer.invoke('rules:list'),
    create: (payload) => ipcRenderer.invoke('rules:create', payload),
    update: (id, payload) => ipcRenderer.invoke('rules:update', id, payload),
    remove: (id: string) => ipcRenderer.invoke('rules:delete', id),
  },

  // Hooks
  hooks: {
    list: () => ipcRenderer.invoke('hooks:list'),
    create: (payload) => ipcRenderer.invoke('hooks:create', payload),
    update: (id, payload) => ipcRenderer.invoke('hooks:update', id, payload),
    remove: (id: string) => ipcRenderer.invoke('hooks:delete', id),
  },

  // Skills
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    getContent: (name: string) => ipcRenderer.invoke('skills:getContent', name),
    install: (name: string, content: string, description?: string, whenToUse?: string) =>
      ipcRenderer.invoke('skills:install', name, content, description, whenToUse),
    remove: (name: string) => ipcRenderer.invoke('skills:delete', name),
    toggle: (name: string, enabled: boolean) => ipcRenderer.invoke('skills:toggle', name, enabled),
  },

  // Agent
  agent: {
    run: (request) => ipcRenderer.invoke('agent:run', request),
    cancel: (sessionId: string) => ipcRenderer.invoke('agent:cancel', sessionId),
    compact: (sessionId: string, instructions?: string) =>
      ipcRenderer.invoke('agent:compact', sessionId, instructions),
    getContext: (sessionId: string) => ipcRenderer.invoke('agent:getContext', sessionId),
    quickCommand: (sessionId: string, command: string, hostName?: string) =>
      ipcRenderer.invoke('agent:quick-command', sessionId, command, hostName),
    respondAuthorization: (response) =>
      ipcRenderer.invoke('agent:authorization-response', response),
    respondPlanApproval: (response) => ipcRenderer.invoke('agent:plan-approval-response', response),
    respondAskUser: (response) => ipcRenderer.invoke('agent:ask-user-response', response),
    onTextStream: (handler) => {
      const listener = (_e: unknown, event: unknown) =>
        handler(event as Parameters<typeof handler>[0]);
      ipcRenderer.on('agent:text-stream', listener);
      return () => ipcRenderer.removeListener('agent:text-stream', listener);
    },
    onToolCall: (handler) => {
      const listener = (_e: unknown, event: unknown) =>
        handler(event as Parameters<typeof handler>[0]);
      ipcRenderer.on('agent:tool-call', listener);
      return () => ipcRenderer.removeListener('agent:tool-call', listener);
    },
    onToolResult: (handler) => {
      const listener = (_e: unknown, event: unknown) =>
        handler(event as Parameters<typeof handler>[0]);
      ipcRenderer.on('agent:tool-result', listener);
      return () => ipcRenderer.removeListener('agent:tool-result', listener);
    },
    onAuthorizationRequest: (handler) => {
      const listener = (_e: unknown, event: unknown) =>
        handler(event as Parameters<typeof handler>[0]);
      ipcRenderer.on('agent:authorization-request', listener);
      return () => ipcRenderer.removeListener('agent:authorization-request', listener);
    },
    onComplete: (handler) => {
      const listener = (_e: unknown, event: unknown) =>
        handler(event as Parameters<typeof handler>[0]);
      ipcRenderer.on('agent:complete', listener);
      return () => ipcRenderer.removeListener('agent:complete', listener);
    },
    onError: (handler) => {
      const listener = (_e: unknown, event: unknown) =>
        handler(event as Parameters<typeof handler>[0]);
      ipcRenderer.on('agent:error', listener);
      return () => ipcRenderer.removeListener('agent:error', listener);
    },
    onTodosUpdate: (handler) => {
      const listener = (_e: unknown, event: unknown) =>
        handler(event as Parameters<typeof handler>[0]);
      ipcRenderer.on('agent:todos-update', listener);
      return () => ipcRenderer.removeListener('agent:todos-update', listener);
    },
    onPlanApprovalRequest: (handler) => {
      const listener = (_e: unknown, event: unknown) =>
        handler(event as Parameters<typeof handler>[0]);
      ipcRenderer.on('agent:plan-approval-request', listener);
      return () => ipcRenderer.removeListener('agent:plan-approval-request', listener);
    },
    onModeChange: (handler) => {
      const listener = (_e: unknown, event: unknown) =>
        handler(event as Parameters<typeof handler>[0]);
      ipcRenderer.on('agent:mode-change', listener);
      return () => ipcRenderer.removeListener('agent:mode-change', listener);
    },
    onAskUserRequest: (handler) => {
      const listener = (_e: unknown, event: unknown) =>
        handler(event as Parameters<typeof handler>[0]);
      ipcRenderer.on('agent:ask-user-request', listener);
      return () => ipcRenderer.removeListener('agent:ask-user-request', listener);
    },
    onContextUsage: (handler) => {
      const listener = (_e: unknown, event: unknown) =>
        handler(event as Parameters<typeof handler>[0]);
      ipcRenderer.on('agent:context-usage', listener);
      return () => ipcRenderer.removeListener('agent:context-usage', listener);
    },
  },

  // Tasks (TodoWrite)
  tasks: {
    list: (sessionId: string) => ipcRenderer.invoke('tasks:list', sessionId),
    update: (sessionId: string, todos: unknown[]) =>
      ipcRenderer.invoke('tasks:update', sessionId, todos),
  },

  // Terminal (interactive SSH shell + local cmd)
  terminal: {
    start: (hostId: string) => ipcRenderer.invoke('terminal:start', hostId),
    startLocal: () => ipcRenderer.invoke('terminal:startLocal'),
    input: (sessionId: string, data: string) =>
      ipcRenderer.invoke('terminal:input', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
    kill: (sessionId: string) => ipcRenderer.invoke('terminal:kill', sessionId),
    onData: (handler) => {
      const listener = (_e: unknown, sessionId: string, data: string) => handler(sessionId, data);
      ipcRenderer.on('terminal:data', listener);
      return () => ipcRenderer.removeListener('terminal:data', listener);
    },
    onExit: (handler) => {
      const listener = (
        _e: unknown,
        sessionId: string,
        info: { hostName: string; reason: string },
      ) => handler(sessionId, info);
      ipcRenderer.on('terminal:exit', listener);
      return () => ipcRenderer.removeListener('terminal:exit', listener);
    },
    onReconnect: (handler) => {
      const listener = (
        _e: unknown,
        sessionId: string,
        info: { hostName: string; attempt: number },
      ) => handler(sessionId, info);
      ipcRenderer.on('terminal:reconnect', listener);
      return () => ipcRenderer.removeListener('terminal:reconnect', listener);
    },
  },

  // SFTP (file transfer)
  sftp: {
    list: (hostId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:list', hostId, remotePath),
    upload: (hostId: string, localPath: string, remotePath: string, transferId: string) =>
      ipcRenderer.invoke('sftp:upload', hostId, localPath, remotePath, transferId),
    download: (hostId: string, remotePath: string, localPath: string, transferId: string) =>
      ipcRenderer.invoke('sftp:download', hostId, remotePath, localPath, transferId),
    realpath: (hostId: string) => ipcRenderer.invoke('sftp:realpath', hostId),
    cancel: (transferId: string) => ipcRenderer.invoke('sftp:cancel', transferId),
    onProgress: (handler) => {
      const listener = (_e: unknown, event: unknown) =>
        handler(event as Parameters<typeof handler>[0]);
      ipcRenderer.on('sftp:progress', listener);
      return () => ipcRenderer.removeListener('sftp:progress', listener);
    },
  },

  // Native file dialogs
  dialog: {
    saveFile: (defaultName: string, title?: string) =>
      ipcRenderer.invoke('dialog:saveFile', defaultName, title),
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
  },

  // AI command generation
  ai: {
    generateCommand: (naturalLanguage: string, hostId?: string) =>
      ipcRenderer.invoke('ai:generateCommand', naturalLanguage, hostId),
  },

  // Window management
  window: {
    restoreFocus: () => ipcRenderer.invoke('window:restoreFocus'),
  },
};

contextBridge.exposeInMainWorld('opsAgent', api);
