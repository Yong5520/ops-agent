import { describe, it, expect } from 'vitest';
import {
  createDenialTracker,
  recordDenial,
  recordApproval,
  shouldNudgeAfterDenials,
  resetDenialNudges,
} from '../denial-tracking.js';

describe('denial-tracking', () => {
  describe('createDenialTracker', () => {
    it('creates a tracker with zero denials', () => {
      const tracker = createDenialTracker();
      expect(tracker.consecutiveDenials).toBe(0);
      expect(tracker.totalDenials).toBe(0);
      expect(tracker.nudgeCount).toBe(0);
      expect(tracker.lastDeniedTool).toBeUndefined();
      expect(tracker.lastDeniedCommand).toBeUndefined();
      expect(tracker.lastDeniedReason).toBeUndefined();
    });
  });

  describe('recordDenial', () => {
    it('increments consecutiveDenials and totalDenials', () => {
      const tracker = createDenialTracker();
      recordDenial(tracker, 'exec', 'User rejected');
      expect(tracker.consecutiveDenials).toBe(1);
      expect(tracker.totalDenials).toBe(1);
      expect(tracker.lastDeniedTool).toBe('exec');
      expect(tracker.lastDeniedReason).toBe('User rejected');
    });

    it('accumulates across multiple denials', () => {
      const tracker = createDenialTracker();
      recordDenial(tracker, 'exec', 'reason1', 'ls -la');
      recordDenial(tracker, 'sudo_exec', 'reason2', 'rm -rf /');
      recordDenial(tracker, 'write_file', 'reason3');
      expect(tracker.consecutiveDenials).toBe(3);
      expect(tracker.totalDenials).toBe(3);
      expect(tracker.lastDeniedTool).toBe('write_file');
      expect(tracker.lastDeniedCommand).toBeUndefined();
      expect(tracker.lastDeniedReason).toBe('reason3');
    });

    it('stores command when provided', () => {
      const tracker = createDenialTracker();
      recordDenial(tracker, 'exec', 'blocked', 'systemctl restart nginx');
      expect(tracker.lastDeniedCommand).toBe('systemctl restart nginx');
    });
  });

  describe('recordApproval', () => {
    it('resets consecutiveDenials but keeps totalDenials', () => {
      const tracker = createDenialTracker();
      recordDenial(tracker, 'exec', 'rejected');
      recordDenial(tracker, 'exec', 'rejected');
      expect(tracker.consecutiveDenials).toBe(2);
      expect(tracker.totalDenials).toBe(2);

      recordApproval(tracker);
      expect(tracker.consecutiveDenials).toBe(0);
      expect(tracker.totalDenials).toBe(2); // total NOT reset
    });
  });

  describe('shouldNudgeAfterDenials', () => {
    it('does not nudge when below threshold', () => {
      const tracker = createDenialTracker();
      recordDenial(tracker, 'exec', 'reason1');
      recordDenial(tracker, 'exec', 'reason2');
      const result = shouldNudgeAfterDenials(tracker);
      expect(result.shouldNudge).toBe(false);
    });

    it('nudges when threshold reached (3 denials)', () => {
      const tracker = createDenialTracker();
      recordDenial(tracker, 'exec', 'reason1', 'cmd1');
      recordDenial(tracker, 'exec', 'reason2', 'cmd2');
      recordDenial(tracker, 'exec', 'reason3', 'cmd3');
      const result = shouldNudgeAfterDenials(tracker);
      expect(result.shouldNudge).toBe(true);
      expect(result.reason).toContain('3');
      expect(result.reason).toContain('cmd3');
    });

    it('increments nudgeCount each time it nudges', () => {
      const tracker = createDenialTracker();
      // Hit threshold 3 times (but MAX_NUDGES = 2, so only first 2 nudge)
      for (let i = 0; i < 3; i++) {
        recordDenial(tracker, 'exec', 'reason');
      }
      const r1 = shouldNudgeAfterDenials(tracker);
      expect(r1.shouldNudge).toBe(true);
      expect(tracker.nudgeCount).toBe(1);

      // Reset consecutive to hit threshold again
      for (let i = 0; i < 3; i++) {
        recordDenial(tracker, 'exec', 'reason');
      }
      const r2 = shouldNudgeAfterDenials(tracker);
      expect(r2.shouldNudge).toBe(true);
      expect(tracker.nudgeCount).toBe(2);
    });

    it('stops nudging after MAX_DENIAL_NUDGES (2)', () => {
      const tracker = createDenialTracker();
      // First nudge
      for (let i = 0; i < 3; i++) recordDenial(tracker, 'exec', 'reason');
      shouldNudgeAfterDenials(tracker); // nudge 1

      // Second nudge
      for (let i = 0; i < 3; i++) recordDenial(tracker, 'exec', 'reason');
      shouldNudgeAfterDenials(tracker); // nudge 2

      // Third attempt - should NOT nudge
      for (let i = 0; i < 3; i++) recordDenial(tracker, 'exec', 'reason');
      const r3 = shouldNudgeAfterDenials(tracker);
      expect(r3.shouldNudge).toBe(false);
    });

    it('includes last denied command in reason when available', () => {
      const tracker = createDenialTracker();
      recordDenial(tracker, 'sudo_exec', 'blocked', 'rm -rf /tmp');
      recordDenial(tracker, 'sudo_exec', 'blocked', 'rm -rf /tmp');
      recordDenial(tracker, 'sudo_exec', 'blocked', 'rm -rf /tmp');
      const result = shouldNudgeAfterDenials(tracker);
      expect(result.shouldNudge).toBe(true);
      expect(result.reason).toContain('rm -rf /tmp');
    });

    it('reason does not include command when not available', () => {
      const tracker = createDenialTracker();
      recordDenial(tracker, 'exec', 'reason1');
      recordDenial(tracker, 'exec', 'reason2');
      recordDenial(tracker, 'exec', 'reason3');
      const result = shouldNudgeAfterDenials(tracker);
      expect(result.shouldNudge).toBe(true);
      expect(result.reason).not.toContain('最近拒绝');
    });
  });

  describe('resetDenialNudges', () => {
    it('resets nudgeCount and consecutiveDenials', () => {
      const tracker = createDenialTracker();
      for (let i = 0; i < 3; i++) recordDenial(tracker, 'exec', 'reason');
      shouldNudgeAfterDenials(tracker);
      expect(tracker.nudgeCount).toBe(1);
      expect(tracker.consecutiveDenials).toBe(3);

      resetDenialNudges(tracker);
      expect(tracker.nudgeCount).toBe(0);
      expect(tracker.consecutiveDenials).toBe(0);
    });
  });

  describe('full denial + approval cycle', () => {
    it('tracks a realistic session: 2 denials, approval, 3 denials, nudge', () => {
      const tracker = createDenialTracker();

      // 2 denials
      recordDenial(tracker, 'exec', 'r1');
      recordDenial(tracker, 'exec', 'r2');
      expect(shouldNudgeAfterDenials(tracker).shouldNudge).toBe(false);

      // Approval resets
      recordApproval(tracker);
      expect(tracker.consecutiveDenials).toBe(0);

      // 3 more denials -> threshold hit
      recordDenial(tracker, 'exec', 'r3', 'cmd3');
      recordDenial(tracker, 'exec', 'r4', 'cmd4');
      recordDenial(tracker, 'exec', 'r5', 'cmd5');
      const nudge = shouldNudgeAfterDenials(tracker);
      expect(nudge.shouldNudge).toBe(true);
      expect(tracker.totalDenials).toBe(5); // total across session
    });
  });
});
