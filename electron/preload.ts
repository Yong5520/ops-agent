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

  // Agent
  agent: {
    run: (request) => ipcRenderer.invoke('agent:run', request),
    cancel: (sessionId: string) => ipcRenderer.invoke('agent:cancel', sessionId),
    respondAuthorization: (response) =>
      ipcRenderer.invoke('agent:authorization-response', response),
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
};

contextBridge.exposeInMainWorld('opsAgent', api);
