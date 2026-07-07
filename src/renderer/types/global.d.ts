// Type declaration for the renderer process.
// Re-declares the OpsAgentApi surface that's exposed via contextBridge.
// We don't import from src/main/ to keep the renderer type config isolated.

import type {
  HostConfig,
  HostInput,
  ModelProvider,
  ModelProviderInput,
  Session,
  SessionInput,
  Message,
  MessageInput,
  AuditLog,
  AuditLogInput,
  AuditFilter,
  AppSetting,
  CustomRule,
  CustomRuleInput,
  SafetyMode,
} from '../shared/types.js';

interface AgentRunRequest {
  sessionId: string;
  userMessage: string;
  hostIds: string[];
  safetyMode: SafetyMode;
  maxSteps?: number;
}

interface AgentTextStreamEvent {
  sessionId: string;
  text: string;
}

interface AgentToolCallEvent {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  hostId?: string;
  hostName?: string;
  command?: string;
  description?: string;
  commandType: 'READ' | 'WRITE' | 'SUDO' | 'BLOCKED';
  needsApproval: boolean;
}

interface AgentToolResultEvent {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
  blockedReason?: string;
  authorization: 'auto' | 'approved' | 'rejected' | 'blocked';
  partial?: boolean;
}

interface AgentAuthorizationRequest {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  hostName: string;
  hostIp: string;
  command: string;
  description?: string;
  commandType: 'READ' | 'WRITE' | 'SUDO' | 'BLOCKED';
  safetyMode: SafetyMode;
  backupPaths?: string[];
}

interface AgentAuthorizationResponse {
  toolCallId: string;
  approved: boolean;
  reason?: string;
  backup?: boolean;
}

interface AgentCompleteEvent {
  sessionId: string;
  finalMessage: string;
}

interface AgentErrorEvent {
  sessionId: string;
  message: string;
}

interface OpsAgentApi {
  ping: () => Promise<string>;
  hosts: {
    list: () => Promise<HostConfig[]>;
    get: (id: string) => Promise<HostConfig | null>;
    create: (payload: HostInput) => Promise<HostConfig>;
    update: (id: string, payload: Partial<HostInput>) => Promise<HostConfig>;
    remove: (id: string) => Promise<void>;
    testConnection: (id: string) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
    listStatus: () => Promise<
      Array<{
        hostId: string;
        hostName: string;
        state: string;
        circuit: 'closed' | 'open' | 'half-open';
        circuitReason?: string;
      }>
    >;
  };
  models: {
    list: () => Promise<ModelProvider[]>;
    create: (payload: ModelProviderInput) => Promise<ModelProvider>;
    update: (id: string, payload: Partial<ModelProviderInput>) => Promise<ModelProvider>;
    remove: (id: string) => Promise<void>;
    setActive: (id: string) => Promise<void>;
    getActive: () => Promise<ModelProvider | null>;
  };
  sessions: {
    list: () => Promise<Session[]>;
    get: (id: string) => Promise<Session | null>;
    create: (payload: SessionInput) => Promise<Session>;
    update: (id: string, payload: Partial<SessionInput>) => Promise<Session>;
    remove: (id: string) => Promise<void>;
    messages: (sessionId: string) => Promise<Message[]>;
    addMessage: (payload: MessageInput) => Promise<Message>;
    deleteMessagesAfter: (sessionId: string, messageId: string) => Promise<number>;
    export: (sessionId: string) => Promise<{ markdown: string; filename: string }>;
  };
  audit: {
    list: (filter: AuditFilter) => Promise<AuditLog[]>;
    create: (payload: AuditLogInput) => Promise<AuditLog>;
  };
  settings: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<AppSetting>;
    getAll: () => Promise<AppSetting[]>;
  };
  rules: {
    list: () => Promise<CustomRule[]>;
    create: (payload: CustomRuleInput) => Promise<CustomRule>;
    update: (id: string, payload: Partial<CustomRuleInput>) => Promise<CustomRule>;
    remove: (id: string) => Promise<void>;
  };
  agent: {
    run: (request: AgentRunRequest) => Promise<void>;
    cancel: (sessionId: string) => Promise<void>;
    respondAuthorization: (response: AgentAuthorizationResponse) => Promise<void>;
    onTextStream: (handler: (event: AgentTextStreamEvent) => void) => () => void;
    onToolCall: (handler: (event: AgentToolCallEvent) => void) => () => void;
    onToolResult: (handler: (event: AgentToolResultEvent) => void) => () => void;
    onAuthorizationRequest: (handler: (event: AgentAuthorizationRequest) => void) => () => void;
    onComplete: (handler: (event: AgentCompleteEvent) => void) => () => void;
    onError: (handler: (event: AgentErrorEvent) => void) => () => void;
  };
}

declare global {
  interface Window {
    opsAgent: OpsAgentApi;
  }
}

export {};
