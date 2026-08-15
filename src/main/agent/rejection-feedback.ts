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

  const parts: string[] = ['用户拒绝执行该命令。', `被拒绝的命令：${command}`];

  if (userReason && userReason.trim()) {
    parts.push(`用户说明：${userReason.trim()}`);
  }

  if (stopRequested) {
    // The user clicked "拒绝并停止" - they want the task to STOP. Do NOT
    // direct the model to ask_user here: that created an unabortable
    // blocking tool call in the subsequent wind-down turn and hung the loop.
    // Tell the model to stop and wait for the user's next instruction.
    parts.push(
      '请勿重复尝试相同或类似的命令。用户已要求停止当前任务，请停止执行任何需要授权的命令，等待用户进一步指示。',
    );
  } else {
    parts.push(
      '请勿重复尝试相同或类似的命令；如需继续，请使用 ask_user 工具向用户确认正确的执行路径，不要自行尝试替代命令。',
    );
  }

  return parts.join(' ');
}

// Directive injected as a user message for the wind-down turn after the user
// clicked "拒绝并停止". Tells the model to summarize progress in text and stop.
// It must NOT call any tools - including ask_user. An earlier version directed
// the model to ask_user, which created an unabortable blocking tool call that
// hung the loop (the user had already said STOP, so popping another question
// was both unwanted and a hang vector).
export const WIND_DOWN_DIRECTIVE =
  '用户已明确要求停止执行命令。请简要总结到目前为止已完成的进展并以文字回复，然后停止。' +
  '不要调用任何工具，也不要向用户提问，等待用户的下一步指示。';
