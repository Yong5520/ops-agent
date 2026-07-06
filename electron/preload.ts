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
};

contextBridge.exposeInMainWorld('opsAgent', api);
