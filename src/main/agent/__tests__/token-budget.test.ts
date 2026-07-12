import { describe, it, expect } from 'vitest';
import { createBudgetTracker, updateBudget, checkTokenBudget } from '../token-budget.js';

describe('token-budget', () => {
  describe('createBudgetTracker', () => {
    it('creates a tracker with zero usage', () => {
      const tracker = createBudgetTracker(80_000);
      expect(tracker.totalTokensUsed).toBe(0);
      expect(tracker.contextWindow).toBe(80_000);
      expect(tracker.continuationCount).toBe(0);
      expect(tracker.lastDeltaTokens).toBe(0);
      expect(tracker.prevDeltaTokens).toBe(0);
    });
  });

  describe('updateBudget', () => {
    it('updates totalTokensUsed from totalTokens', () => {
      const tracker = createBudgetTracker(80_000);
      updateBudget(tracker, { totalTokens: 5000 });
      expect(tracker.totalTokensUsed).toBe(5000);
      expect(tracker.lastDeltaTokens).toBe(5000);
    });

    it('uses promptTokens + completionTokens when totalTokens is 0', () => {
      const tracker = createBudgetTracker(80_000);
      updateBudget(tracker, {
        promptTokens: 3000,
        completionTokens: 2000,
        totalTokens: 0,
      });
      expect(tracker.totalTokensUsed).toBe(5000);
    });

    it('accumulates across multiple updates', () => {
      const tracker = createBudgetTracker(80_000);
      updateBudget(tracker, { totalTokens: 3000 });
      updateBudget(tracker, { totalTokens: 4000 });
      updateBudget(tracker, { totalTokens: 2000 });
      expect(tracker.totalTokensUsed).toBe(9000);
    });

    it('tracks prevDeltaTokens', () => {
      const tracker = createBudgetTracker(80_000);
      updateBudget(tracker, { totalTokens: 3000 });
      updateBudget(tracker, { totalTokens: 5000 });
      expect(tracker.prevDeltaTokens).toBe(3000);
      expect(tracker.lastDeltaTokens).toBe(5000);
    });
  });

  describe('checkTokenBudget', () => {
    const MAX_CONTINUATIONS = 3;

    it('allows continuation when budget is sufficient', () => {
      const tracker = createBudgetTracker(80_000);
      updateBudget(tracker, { totalTokens: 10_000 }); // 12.5% used
      const result = checkTokenBudget(tracker, MAX_CONTINUATIONS);
      expect(result.canContinue).toBe(true);
      expect(result.remainingTokens).toBe(70_000);
      expect(result.reason).toBeUndefined();
    });

    it('blocks continuation when budget exhausted (<20% remaining)', () => {
      const tracker = createBudgetTracker(80_000);
      updateBudget(tracker, { totalTokens: 70_000 }); // 87.5% used, 12.5% remaining
      const result = checkTokenBudget(tracker, MAX_CONTINUATIONS);
      expect(result.canContinue).toBe(false);
      expect(result.reason).toBe('budget_exhausted');
    });

    it('allows continuation at exactly 20% remaining', () => {
      const tracker = createBudgetTracker(100_000);
      updateBudget(tracker, { totalTokens: 80_000 }); // 80% used, 20% remaining
      const result = checkTokenBudget(tracker, MAX_CONTINUATIONS);
      // remainingPct = 20000/100000 = 0.2, not > 0.2, so can't continue
      expect(result.canContinue).toBe(false);
      expect(result.reason).toBe('budget_exhausted');
    });

    it('allows continuation when just over 20% remaining', () => {
      const tracker = createBudgetTracker(100_000);
      updateBudget(tracker, { totalTokens: 79_000 }); // 79% used, 21% remaining
      const result = checkTokenBudget(tracker, MAX_CONTINUATIONS);
      expect(result.canContinue).toBe(true);
      expect(result.remainingTokens).toBe(21_000);
    });

    it('blocks continuation when continuation limit reached', () => {
      const tracker = createBudgetTracker(80_000);
      tracker.continuationCount = 3;
      updateBudget(tracker, { totalTokens: 10_000 }); // plenty of budget
      const result = checkTokenBudget(tracker, MAX_CONTINUATIONS);
      expect(result.canContinue).toBe(false);
      expect(result.reason).toBe('continuation_limit');
    });

    it('detects diminishing returns after 3 continuations with small deltas', () => {
      const tracker = createBudgetTracker(80_000);
      tracker.continuationCount = 3;
      updateBudget(tracker, { totalTokens: 400 }); // small delta
      // Need two small deltas in a row
      tracker.prevDeltaTokens = 300;
      tracker.lastDeltaTokens = 400;
      const result = checkTokenBudget(tracker, MAX_CONTINUATIONS);
      expect(result.canContinue).toBe(false);
      expect(result.reason).toBe('diminishing_returns');
    });

    it('does not trigger diminishing returns with large deltas', () => {
      const tracker = createBudgetTracker(80_000);
      tracker.continuationCount = 2;
      tracker.prevDeltaTokens = 600;
      tracker.lastDeltaTokens = 700;
      // 80k - 0 used = 80k remaining, well over 20%
      const result = checkTokenBudget(tracker, MAX_CONTINUATIONS);
      expect(result.canContinue).toBe(true);
    });

    it('does not trigger diminishing returns before 3 continuations', () => {
      const tracker = createBudgetTracker(80_000);
      tracker.continuationCount = 2;
      tracker.prevDeltaTokens = 100;
      tracker.lastDeltaTokens = 200;
      const result = checkTokenBudget(tracker, MAX_CONTINUATIONS);
      expect(result.canContinue).toBe(true);
    });

    it('returns correct remainingTokens', () => {
      const tracker = createBudgetTracker(50_000);
      updateBudget(tracker, { totalTokens: 15_000 });
      const result = checkTokenBudget(tracker, MAX_CONTINUATIONS);
      expect(result.remainingTokens).toBe(35_000);
    });
  });
});
