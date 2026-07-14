import type {
  SafetyMode,
  CommandType,
  AuthorizationStatus,
  HostConfig,
  TodoItem,
} from '../../shared/types.js';
import type { PlanApprovalResult, ModeChangeCallback } from './tools/exit-plan-mode.js';
import type { AskUserCallback } from './tools/ask-user.js';

// Agent loop input parameters.
export interface AgentLoopParams {
  sessionId: string;
  userMessage: string;
  hostIds: string[];
  safetyMode: SafetyMode;
  maxSteps?: number;
  // When aborted, the loop stops as soon as the current stream step yields.
  abortSignal?: AbortSignal;
  // Streaming callbacks - invoked from the main process to drive the UI.
  onTextStream: (text: string) => void;
  onToolCall: (info: ToolCallInfo) => void;
  onToolResult: (result: ToolCallResult) => void;
  // Authorization callback - async, resolves when user approves/rejects.
  onAuthorizationRequired: (request: AuthorizationRequest) => Promise<AuthorizationResponse>;
  onTodosUpdate?: (todos: TodoItem[]) => void;
  // Plan approval callback - resolves when user approves/rejects plan (P0-1.B)
  onPlanApproval?: (plan: string) => Promise<PlanApprovalResult>;
  // Mode change callback - notifies renderer when ExitPlanMode switches mode (P0-1.B fix)
  onModeChange?: ModeChangeCallback;
  // AskUserQuestion callback - resolves with user's answers (P1-4)
  onAskUser?: AskUserCallback;
  // Context usage callback - notifies renderer of token usage after each
  // model response so the chat header can display occupancy percentage.
  onContextUsage?: (event: {
    sessionId: string;
    usedTokens: number;
    totalTokens: number;
    percentage: number;
  }) => void;
  onComplete: (finalMessage: string) => void;
  onError: (error: Error) => void;
}

// Information about a pending tool call, sent to UI for display.
export interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  hostId?: string;
  hostName?: string;
  command?: string;
  description?: string;
  commandType: CommandType;
  needsApproval: boolean;
}

// Result of a tool call, sent to UI after execution.
export interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
  blockedReason?: string;
  authorization: AuthorizationStatus;
  // When true, this is an incremental chunk during streaming output -
  // the UI should append to the existing card's output rather than replace.
  partial?: boolean;
}

// Authorization request sent to UI when user confirmation is needed.
export interface AuthorizationRequest {
  toolCallId: string;
  toolName: string;
  hostName: string;
  hostIp: string;
  command: string;
  description?: string;
  commandType: CommandType;
  safetyMode: SafetyMode;
  // File paths that will be modified by this operation. When present,
  // the AuthDialog shows a "backup before modification" checkbox. If the
  // user checks it, the response includes backup: true and the system
  // creates timestamped backups before executing.
  backupPaths?: string[];
}

// User's response to an authorization request.
export interface AuthorizationResponse {
  approved: boolean;
  reason?: string;
  // When true, the user requested a backup before execution.
  // The tool should create backups of backupPaths before proceeding.
  backup?: boolean;
}

// Internal record for audit logging.
export interface ToolExecutionRecord {
  sessionId: string;
  hostId?: string;
  hostName: string;
  hostIp: string;
  toolName: string;
  command: string;
  description?: string;
  commandType: CommandType;
  authorization: AuthorizationStatus;
  exitCode?: number;
  durationMs?: number;
  outputSummary?: string;
  blockedReason?: string;
}

// Context for a single agent loop invocation.
export interface SessionContext {
  sessionId: string;
  hostIds: string[];
  hostName: string;
  hostIp: string;
  safetyMode: SafetyMode;
  defaultHost?: HostConfig;
}
