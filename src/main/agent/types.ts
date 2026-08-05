import type {
  SafetyMode,
  CommandType,
  AuthorizationStatus,
  HostConfig,
  TodoItem,
} from '../../shared/types.js';
import type { PlanApprovalResult, ModeChangeCallback } from './tools/exit-plan-mode.js';
import type { AskUserCallback } from './tools/ask-user.js';

// Image attachment input from the renderer (base64 data URL).
export interface AttachmentInput {
  data: string; // base64 data URL: data:image/png;base64,xxxx
  mimeType: string;
  originalName?: string;
}

// Agent loop input parameters.
export interface AgentLoopParams {
  sessionId: string;
  userMessage: string;
  hostIds: string[];
  safetyMode: SafetyMode;
  // Per-session model override. When set, the loop resolves this provider
  // (with decrypted apiKey) instead of the global active default. Resolution
  // order: params.modelProviderId -> session.modelProviderId -> global active.
  modelProviderId?: string;
  maxSteps?: number;
  attachments?: AttachmentInput[];
  // When aborted, the loop stops as soon as the current stream step yields.
  abortSignal?: AbortSignal;
  // Phase B: optional shared ref so callers/tests can observe or trigger the
  // "拒绝并停止" wind-down path. When preExec sets current=true (user clicked
  // reject-and-stop), the loop breaks and runs a wind-down turn. Defaults to
  // an internal ref when not provided.
  stopRequestedRef?: StopRequestedRef;
  // Streaming callbacks - invoked from the main process to drive the UI.
  onTextStream: (text: string) => void;
  // Thinking/reasoning stream - emits structured events so the UI can render
  // each thinking block as a separate collapsible card. Undefined for
  // non-thinking models (the parser never opens a block, so no events fire).
  onThinkingStream?: (event: ThinkingStreamEvent) => void;
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
  // The command that was rejected/blocked. Populated on rejected/blocked
  // results so the loop's denial tracker can reference the actual command
  // (without this, the nudge message can't tell the model what was rejected).
  command?: string;
  // True when the user rejected via "拒绝并停止" - signals the loop to break
  // and run a wind-down turn instead of continuing to propose commands.
  stopRequested?: boolean;
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
  // When set, the user edited the command in the AuthDialog before approving.
  // preExec re-validates it (sanitize + security re-check); if it passes, this
  // replaces the original command for execution. If it hits a blocked rule,
  // the command is blocked regardless of the approval.
  editedCommand?: string;
  // When true (with approved=false), the user clicked "拒绝并停止" - reject this
  // command AND stop the task. The loop breaks and runs a wind-down turn.
  stopRequested?: boolean;
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
  // True when the executed command was edited by the user in the AuthDialog
  // (differs from what the model proposed). For audit traceability.
  editedByUser?: boolean;
}

// Streaming event for a thinking/reasoning block. The renderer reconstructs
// blocks by blockId: first sighting opens a block, deltas append content,
// `closed` finalizes it with a duration.
export interface ThinkingStreamEvent {
  blockId: string;
  // Thinking content delta. Absent on a pure open signal.
  delta?: string;
  // True when the block is finalized. durationMs is set alongside it.
  closed?: boolean;
  durationMs?: number;
  // When > 0 (on an open event), this many chars of previously-streamed answer
  // text were actually reasoning and must be retracted from the text stream
  // into this thinking block. Happens for stray closers (qwen3.5-27b pattern
  // where the opening delimiter never reaches the content stream).
  absorbPrecedingText?: number;
}

// Mutable ref shared between the agent loop and the tools closure (Phase B).
// When the user clicks "拒绝并停止", preExec sets current=true; the loop's
// stream consumer checks this ref and breaks, then runs a wind-down turn.
export interface StopRequestedRef {
  current: boolean;
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
