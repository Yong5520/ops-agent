// Shared types between main and renderer processes.

export type SafetyMode = 'sentinel' | 'operator' | 'autopilot';

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

// ---------- Settings ----------
export type SettingKey =
  'safetyMode' | 'activeModelId' | 'theme' | 'maxSteps' | 'commandTimeoutMs' | 'defaultHostId';

export interface AppSetting {
  key: string;
  value: string;
  updatedAt: string;
}
