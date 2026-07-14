// Shared types between main and renderer processes.

export type SafetyMode = 'sentinel' | 'operator' | 'autopilot' | 'plan';

export type CommandType = 'READ' | 'WRITE' | 'SUDO' | 'BLOCKED';
export type AuthorizationStatus = 'auto' | 'approved' | 'rejected' | 'blocked';

export type AuthType = 'password' | 'key';
export type ModelProviderType = 'anthropic' | 'openai' | 'openai-compatible';

// ---------- Host ----------
export interface HostConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string; // plaintext only in transit; stored encrypted
  keyPath?: string;
  sudoPassword?: string;
  suPassword?: string;
  groupName: string;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export type HostInput = Omit<HostConfig, 'id' | 'createdAt' | 'updatedAt'>;

// ---------- Model provider ----------
export interface ModelProvider {
  id: string;
  name: string;
  type: ModelProviderType;
  endpoint: string;
  apiKey?: string; // plaintext only in transit; stored encrypted
  modelName: string;
  contextWindow?: number; // optional: user-configured context window size in tokens
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ModelProviderInput = Omit<ModelProvider, 'id' | 'createdAt' | 'updatedAt' | 'isActive'>;

// ---------- Session / Message ----------
export interface Session {
  id: string;
  title?: string;
  hostIds?: string[];
  safetyMode: SafetyMode;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export type SessionInput = Pick<Session, 'title' | 'hostIds' | 'safetyMode' | 'status'>;

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokenCount?: number;
  createdAt: string;
}

export interface MessageInput {
  sessionId: string;
  role: Message['role'];
  content: string;
  tokenCount?: number;
}

// ---------- Audit ----------
export interface AuditLog {
  id: string;
  sessionId?: string;
  hostId?: string;
  hostName: string;
  hostIp: string;
  safetyMode: SafetyMode;
  commandType: CommandType;
  command: string;
  description?: string;
  authorization: AuthorizationStatus;
  exitCode?: number;
  durationMs?: number;
  outputSummary?: string;
  createdAt: string;
}

export interface AuditLogInput {
  sessionId?: string;
  hostId?: string;
  hostName: string;
  hostIp: string;
  safetyMode: SafetyMode;
  commandType: CommandType;
  command: string;
  description?: string;
  authorization: AuthorizationStatus;
  exitCode?: number;
  durationMs?: number;
  outputSummary?: string;
}

export interface AuditFilter {
  hostId?: string;
  hostName?: string;
  safetyMode?: SafetyMode;
  commandType?: CommandType;
  keyword?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
  offset?: number;
}

// ---------- Custom rules ----------
export interface CustomRule {
  id: string;
  type: 'blocked' | 'allowed';
  pattern: string;
  reason: string;
  hostId?: string;
  createdAt: string;
}

export type CustomRuleInput = Omit<CustomRule, 'id' | 'createdAt'>;

// ---------- Todo / Task list ----------
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  subject: string;
  description: string;
  status: TodoStatus;
  activeForm?: string;
}

// ---------- Hooks (PreToolUse / PostToolUse) ----------
export type HookEvent = 'PreToolUse' | 'PostToolUse';
export type HookType = 'command' | 'http';
export type HookPermissionDecision = 'allow' | 'deny' | 'pass';

export interface HookConfig {
  name: string;
  event: HookEvent;
  type: HookType;
  command?: string; // shell command for type='command' (receives JSON on stdin)
  url?: string; // webhook URL for type='http'
  method?: 'POST' | 'GET';
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HookCondition {
  toolName: string; // glob-style: 'exec', 'exec(*)', 'exec(rm *)', '*'
  commandPattern?: string; // regex on command input, e.g. 'rm .*'
}

export interface Hook {
  id: string;
  name: string;
  event: HookEvent;
  type: HookType;
  config: HookConfig;
  condition: HookCondition;
  enabled: boolean;
  createdAt: string;
}

// Input for creating/updating a hook (no id/createdAt).
export type HookCreateInput = Omit<Hook, 'id' | 'createdAt'>;

// Hook + tool input, passed to hook executors (command/HTTP).
export type HookInput = Hook & { input?: Record<string, unknown>; result?: unknown };

// ---------- Settings ----------
export type SettingKey =
  'safetyMode' | 'activeModelId' | 'theme' | 'maxSteps' | 'commandTimeoutMs' | 'defaultHostId';

export interface AppSetting {
  key: string;
  value: string;
  updatedAt: string;
}
