// Rejection feedback construction (Phase B1/B2).
//
// When the user rejects a command authorization, the tool's execute function
// returns an error result to the Vercel AI SDK, which feeds it back to the
// model as the tool-call result. Previously this was a bare
// `{ error: "User rejected", blocked: true }` - too weak for the model to
// understand it should stop retrying. This module builds a stronger, explicit
// message that:
//   - names the rejected command
//   - includes an optional user-provided reason
//   - directs the model to use ask_user instead of blindly retrying
//   - when stopRequested, tells the model the user wants the whole task stopped
//
// The short `reason` shown in the UI (ToolCallResult.blockedReason) is kept
// separate; this long feedback is model-facing only (the tool return value).

export interface RejectionFeedbackOptions {
  /** The command the user rejected (sanitized original). */
  command: string;
  /** Optional reason the user typed in the AuthDialog. */
  userReason?: string;
  /** True when the user clicked "拒绝并停止" (reject and stop the task). */
  stopRequested?: boolean;
}

// Build the model-facing feedback string for a rejected authorization.
export function buildRejectionFeedback(opts: RejectionFeedbackOptions): string {
  const { command, userReason, stopRequested } = opts;

  const parts: string[] = [
    '用户拒绝执行该命令。',
    `被拒绝的命令：${command}`,
  ];

  if (userReason && userReason.trim()) {
    parts.push(`用户说明：${userReason.trim()}`);
  }

  parts.push(
    '请勿重复尝试相同或类似的命令；如需继续，请使用 ask_user 工具向用户确认正确的执行路径，不要自行尝试替代命令。',
  );

  if (stopRequested) {
    parts.push('用户已要求停止当前任务，请停止执行任何需要授权的命令。');
  }

  return parts.join(' ');
}

// Directive injected as a user message for the wind-down turn after the user
// clicked "拒绝并停止". Tells the model to summarize progress and ask the user
// how to proceed, and to NOT call any execution tools.
export const WIND_DOWN_DIRECTIVE =
  '用户已明确要求停止执行命令。请简要总结到目前为止已完成的进展，并使用 ask_user 工具询问用户下一步希望如何处理。' +
  '不要再调用任何执行类（exec、sudo_exec、write_file 等）工具。';
