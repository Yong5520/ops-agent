// Stall detection logic for the agent loop.
//
// When the model stops with finishReason='stop' after calling tools, we need
// to decide whether to nudge it for a conclusion or let it stop.
//
// Two stall patterns warrant a nudge:
//   1. Transition stall: short text (< threshold) containing transition words
//      like "让我/继续/下一步" - the model is about to continue but stopped.
//   2. Empty stall: 0 chars of text after tool calls - the model produced no
//      analysis at all.
//
// When the model produces substantive text (> threshold chars, no transition
// words), it has completed its response. We do NOT nudge - this prevents
// over-action where the agent starts fixing things the user only asked it to
// analyze.
//
// Previously, a "token budget continuation" nudge fired whenever the budget
// allowed, pushing the model to "continue executing unfinished tasks, don't
// summarize." This caused the agent to take actions beyond what was requested
// (e.g., downloading packages when the user only asked for analysis). That
// continuation has been removed.

export interface StallDecisionInput {
  /** The finishReason from the stream's finish event. */
  finishReason: string;
  /** Number of tool calls made in this round. */
  toolCallCount: number;
  /** The text produced by the model in this round. */
  roundText: string;
  /** How many conclusion nudges have already been issued. */
  nudgeCount: number;
  /** Maximum number of conclusion nudges allowed. */
  maxNudgeRounds: number;
  /** Regex matching transition phrases like "让我/继续/下一步". */
  transitionPattern: RegExp;
  /** Text length below which a transition match is considered a stall. */
  textThreshold: number;
}

export type StallReason =
  | 'transition_stall' // short text + transition words -> nudge for conclusion
  | 'empty_stall' // 0 chars after tools -> nudge for conclusion
  | 'substantive_stop' // >threshold chars, no transition -> model is done
  | 'no_tools' // no tool calls -> not a stall
  | 'not_stop' // finishReason != 'stop' -> handled elsewhere
  | 'nudge_exhausted'; // stall detected but max rounds reached

export interface StallDecision {
  shouldNudge: boolean;
  reason: StallReason;
}

/**
 * Evaluate whether the model's stop after tool calls is a "stall" that
 * warrants a conclusion nudge, or a substantive response that should be
 * left alone.
 *
 * This function does NOT handle the denial-tracker nudge (user repeatedly
 * rejected authorizations) - that is handled separately in the loop.
 */
export function evaluateStallDecision(input: StallDecisionInput): StallDecision {
  // Only evaluate when the model stopped after calling tools.
  if (input.finishReason !== 'stop') {
    return { shouldNudge: false, reason: 'not_stop' };
  }
  if (input.toolCallCount === 0) {
    return { shouldNudge: false, reason: 'no_tools' };
  }

  const isTransitionStall =
    input.roundText.length > 0 &&
    input.roundText.length < input.textThreshold &&
    input.transitionPattern.test(input.roundText);
  const isEmptyStall = input.roundText.length === 0;

  if (isTransitionStall || isEmptyStall) {
    // Only nudge if we haven't exhausted the nudge budget.
    if (input.nudgeCount < input.maxNudgeRounds) {
      return {
        shouldNudge: true,
        reason: isTransitionStall ? 'transition_stall' : 'empty_stall',
      };
    }
    return { shouldNudge: false, reason: 'nudge_exhausted' };
  }

  // Model produced substantive text (>threshold chars without transition
  // words, or short text without transition words). This is a complete
  // response - do NOT nudge. Nudging here causes over-action.
  return { shouldNudge: false, reason: 'substantive_stop' };
}
