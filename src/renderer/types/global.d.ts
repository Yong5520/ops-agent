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
  TodoItem,
  Hook,
  HookCreateInput,
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

interface AgentTodosUpdateEvent {
  sessionId: string;
  todos: TodoItem[];
}

interface AgentPlanApprovalRequestEvent {
  sessionId: string;
  plan: string;
}

interface AgentPlanApprovalResponse {
  sessionId: string;
  approved: boolean;
  editedPlan?: string;
  reason?: string;
}

interface AgentModeChangeEvent {
  sessionId: string;
  mode: SafetyMode;
}

// AskUserQuestion types (P1-4) - mirrors preload-api.ts
interface AskUserOption {
  label: string;
  description?: string;
}

interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserOption[];
  multiSelect: boolean;
}

interface AskUserAnswer {
  question: string;
  answer: string;
  isOther?: boolean;
  notes?: string;
}

interface AgentAskUserRequestEvent {
  sessionId: string;
  questions: AskUserQuestionItem[];
}

interface AgentAskUserResponse {
  sessionId: string;
  answers: AskUserAnswer[];
  dismissed?: boolean;
}

interface AgentContextUsageEvent {
  sessionId: string;
  usedTokens: number;
  totalTokens: number;
  percentage: number;
}

interface AgentCompactResult {
  ok: boolean;
  reason?: 'too_few_messages' | 'no_model';
  messageCount?: number;
  compressedCount?: number;
  summary?: string;
}

interface QuickCommandResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  hostName?: string;
  command?: string;
}

interface ContextBreakdownCategory {
  name: string;
  tokens: number;
  percentage: number;
}

interface ContextBreakdownSection {
  name: string;
  tokens: number;
}

interface ContextBreakdown {
  model: string;
  contextWindow: number;
  totalUsed: number;
  percentage: number;
  categories: ContextBreakdownCategory[];
  systemPromptSections: ContextBreakdownSection[];
  tools: ContextBreakdownSection[];
  skills: Array<{ name: string; tokens: number; enabled: boolean }>;
  messageBreakdown: {
    userMessages: number;
    assistantMessages: number;
    systemMessages: number;
    totalTokens: number;
  };
}

interface SftpDirEntry {
  name: string;
  longname: string;
  isDirectory: boolean;
  size: number;
  modifyTime: number;
}

interface SftpProgressEvent {
  direction: 'upload' | 'download';
  hostId: string;
  remotePath: string;
  localPath?: string;
  transferred: number;
  total: number;
  transferId?: string;
}

interface SkillInfo {
  name: string;
  displayName: string;
  description: string;
  whenToUse?: string;
  source: 'builtin' | 'user';
  enabled: boolean;
  enabledByDefault: boolean;
  filePath?: string;
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
    batchCreate: (payloads: HostInput[]) => Promise<{
      created: HostConfig[];
      errors: Array<{ row: number; name: string; error: string }>;
    }>;
    renameGroup: (oldName: string, newName: string) => Promise<number>;
    deleteGroup: (groupName: string) => Promise<number>;
    listGroups: () => Promise<string[]>;
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
    verifyIntegrity: () => Promise<string[]>;
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
  hooks: {
    list: () => Promise<Hook[]>;
    create: (payload: HookCreateInput) => Promise<Hook>;
    update: (id: string, payload: Partial<HookCreateInput>) => Promise<Hook>;
    remove: (id: string) => Promise<void>;
  };
  skills: {
    list: () => Promise<SkillInfo[]>;
    getContent: (name: string) => Promise<string | null>;
    install: (
      name: string,
      content: string,
      description?: string,
      whenToUse?: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    remove: (name: string) => Promise<{ ok: boolean; error?: string }>;
    toggle: (name: string, enabled: boolean) => Promise<void>;
  };
  agent: {
    run: (request: AgentRunRequest) => Promise<void>;
    cancel: (sessionId: string) => Promise<void>;
    compact: (sessionId: string, instructions?: string) => Promise<AgentCompactResult>;
    getContext: (sessionId: string) => Promise<ContextBreakdown>;
    quickCommand: (
      sessionId: string,
      command: string,
      hostName?: string,
    ) => Promise<QuickCommandResult>;
    respondAuthorization: (response: AgentAuthorizationResponse) => Promise<void>;
    respondPlanApproval: (response: AgentPlanApprovalResponse) => Promise<void>;
    respondAskUser: (response: AgentAskUserResponse) => Promise<void>;
    onTextStream: (handler: (event: AgentTextStreamEvent) => void) => () => void;
    onToolCall: (handler: (event: AgentToolCallEvent) => void) => () => void;
    onToolResult: (handler: (event: AgentToolResultEvent) => void) => () => void;
    onAuthorizationRequest: (handler: (event: AgentAuthorizationRequest) => void) => () => void;
    onComplete: (handler: (event: AgentCompleteEvent) => void) => () => void;
    onError: (handler: (event: AgentErrorEvent) => void) => () => void;
    onTodosUpdate: (handler: (event: AgentTodosUpdateEvent) => void) => () => void;
    onPlanApprovalRequest: (handler: (event: AgentPlanApprovalRequestEvent) => void) => () => void;
    onModeChange: (handler: (event: AgentModeChangeEvent) => void) => () => void;
    onAskUserRequest: (handler: (event: AgentAskUserRequestEvent) => void) => () => void;
    onContextUsage: (handler: (event: AgentContextUsageEvent) => void) => () => void;
  };
  tasks: {
    list: (sessionId: string) => Promise<TodoItem[]>;
    update: (sessionId: string, todos: TodoItem[]) => Promise<{ success: boolean }>;
  };
  terminal: {
    start: (hostId: string) => Promise<{ sessionId: string; hostName: string }>;
    startLocal: () => Promise<{ sessionId: string; hostName: string }>;
    input: (sessionId: string, data: string) => Promise<void>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
    kill: (sessionId: string) => Promise<void>;
    onData: (handler: (sessionId: string, data: string) => void) => () => void;
    onExit: (
      handler: (sessionId: string, info: { hostName: string; reason: string }) => void,
    ) => () => void;
    onReconnect: (
      handler: (sessionId: string, info: { hostName: string; attempt: number }) => void,
    ) => () => void;
  };
  sftp: {
    list: (hostId: string, remotePath: string) => Promise<SftpDirEntry[]>;
    upload: (
      hostId: string,
      localPath: string,
      remotePath: string,
      transferId: string,
    ) => Promise<{ bytesTransferred: number; remotePath: string; localPath: string }>;
    download: (
      hostId: string,
      remotePath: string,
      localPath: string,
      transferId: string,
    ) => Promise<{ bytesTransferred: number; remotePath: string; localPath: string }>;
    realpath: (hostId: string) => Promise<string>;
    cancel: (transferId: string) => Promise<boolean>;
    onProgress: (handler: (event: SftpProgressEvent) => void) => () => void;
  };
  dialog: {
    saveFile: (defaultName: string, title?: string) => Promise<string | null>;
    openFile: () => Promise<string | null>;
  };
  ai: {
    generateCommand: (
      naturalLanguage: string,
      hostId?: string,
    ) => Promise<{
      command: string;
      explanation: string;
      safetyLevel: 'read' | 'write' | 'sudo';
    }>;
  };

  window: {
    restoreFocus: () => Promise<void>;
  };
}

declare global {
  interface Window {
    opsAgent: OpsAgentApi;
  }
}

export {};
