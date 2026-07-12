// Token budget tracker for agent loop continuation decisions.
//
// Tracks total tokens consumed across a single agent loop invocation.
// When the model stops with tool calls (inconclusive stop), the loop
// checks the budget: if >20% of the context window remains, inject a
// continuation nudge. If <20%, warn that the budget is exhausted.
//
// Also detects diminishing returns: after 3+ continuations where the
// last two deltas each produced <500 tokens, we stop to avoid wasteful
// API calls.

export interface BudgetTracker {
  totalTokensUsed: number;
  contextWindow: number;
  continuationCount: number;
  lastDeltaTokens: number;
  prevDeltaTokens: number;
}

const CONTINUE_THRESHOLD = 0.2;
const DIMINISHING_CONTINUATION_COUNT = 3;
const DIMINISHING_DELTA_TOKENS = 500;

export function createBudgetTracker(contextWindow: number): BudgetTracker {
  return {
    totalTokensUsed: 0,
    contextWindow,
    continuationCount: 0,
    lastDeltaTokens: 0,
    prevDeltaTokens: 0,
  };
}

export function updateBudget(
  tracker: BudgetTracker,
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
): void {
  const total = usage.totalTokens ?? 0;
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  // Prefer explicit totalTokens; fall back to prompt+completion
  const delta = total > 0 ? total : prompt + completion;

  tracker.prevDeltaTokens = tracker.lastDeltaTokens;
  tracker.lastDeltaTokens = delta;
  tracker.totalTokensUsed += delta;
}

export interface BudgetCheckResult {
  canContinue: boolean;
  remainingTokens: number;
  reason?: 'diminishing_returns' | 'budget_exhausted' | 'continuation_limit';
}

export function checkTokenBudget(
  tracker: BudgetTracker,
  maxContinuations: number,
): BudgetCheckResult {
  const remaining = tracker.contextWindow - tracker.totalTokensUsed;
  const remainingPct = remaining / tracker.contextWindow;

  // Diminishing returns: 3+ continuations and last two deltas < 500 tokens.
  // Checked before continuation limit so we report the more specific reason.
  if (
    tracker.continuationCount >= DIMINISHING_CONTINUATION_COUNT &&
    tracker.lastDeltaTokens < DIMINISHING_DELTA_TOKENS &&
    tracker.prevDeltaTokens < DIMINISHING_DELTA_TOKENS
  ) {
    return {
      canContinue: false,
      remainingTokens: remaining,
      reason: 'diminishing_returns',
    };
  }

  // Check continuation count limit
  if (tracker.continuationCount >= maxContinuations) {
    return {
      canContinue: false,
      remainingTokens: remaining,
      reason: 'continuation_limit',
    };
  }

  // Continue while >20% of context window remains
  if (remainingPct > CONTINUE_THRESHOLD) {
    return { canContinue: true, remainingTokens: remaining };
  }

  return {
    canContinue: false,
    remainingTokens: remaining,
    reason: 'budget_exhausted',
  };
}
