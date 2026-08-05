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
  // V3-09: SSH bastion / agent forwarding / host-key verification.
  jumpHostId?: string; // FK to another host used as a jump/bastion
  agentForward: boolean; // enable OpenSSH agent forwarding
  hostKeyFingerprint?: string; // expected SHA256 fingerprint (TOFU)
  // V3-09.1: encoded-username bastion mode (for bastions that disable TCP
  // forwarding and route via an encoded username like
  // `{bastionUser}@{targetUser}@{targetHost}`). 'forward' (default) = the
  // V3-09 forwardOut/ProxyJump path; 'encoded' = single connection to the
  // bastion with the encoded username, exec runs on the target via bastion
  // routing.
  jumpMode?: 'forward' | 'encoded';
  jumpUsernameTemplate?: string; // default {bastionUser}@{targetUser}@{targetHost}
  jumpTargetAuth?: 'bastion-managed' | 'password'; // default bastion-managed
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
  // Per-million-token pricing (USD) for cost tracking (V3-01). All optional:
  // when unset, estimated_usd = 0 but token totals are still persisted.
  inputPricePerMTok?: number;
  outputPricePerMTok?: number;
  cacheReadPricePerMTok?: number;
  cacheCreationPricePerMTok?: number;
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
  // Per-session model override. When set, this session runs against the
  // referenced model_provider row instead of the global active default.
  // Undefined/null = use the Settings-page active model (the default).
  modelProviderId?: string;
  createdAt: string;
  updatedAt: string;
}

export type SessionInput = Pick<Session, 'title' | 'hostIds' | 'safetyMode' | 'status'> & {
  // Per-session model override. A string sets the override; null explicitly
  // clears it (revert to the global active default). Omitting the key leaves
  // the existing value untouched. null is used (not undefined) so the clear
  // signal survives IPC serialization.
  modelProviderId?: string | null;
};

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokenCount?: number;
  attachments?: MessageAttachment[];
  // Thinking blocks captured separately from the answer text (for reasoning
  // models like glm-5.2 that emit <think>...</think> or reasoning_content).
  // Display-only: never sent back to the model. Empty/undefined for
  // non-thinking models.
  thinkingBlocks?: ThinkingBlock[];
  createdAt: string;
}

// A single reasoning/thinking block extracted from the model's output.
// Rendered as a collapsible "思考 Xm Xs" card in the chat UI.
export interface ThinkingBlock {
  id: string;
  content: string;
  // Wall-clock duration of the thinking block (endMs - startMs). Undefined
  // for legacy messages parsed from <think> tags where no timing was recorded.
  durationMs?: number;
}

export interface MessageAttachment {
  id: string;
  messageId: string;
  sessionId: string;
  type: 'image';
  filePath: string; // relative path under attachments dir: {sessionId}/{filename}
  mimeType: string;
  originalName?: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  createdAt: string;
}

export interface MessageInput {
  sessionId: string;
  role: Message['role'];
  content: string;
  tokenCount?: number;
  // Thinking blocks to persist with an assistant message. Undefined for
  // user/system messages and non-thinking models.
  thinkingBlocks?: ThinkingBlock[];
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
  // Phase A: true when the executed command was edited by the user in the
  // AuthDialog (differs from what the model proposed).
  editedByUser?: boolean;
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
  editedByUser?: boolean;
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
