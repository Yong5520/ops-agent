// Denial tracking module (P1-4).
//
// Tracks consecutive authorization denials per session. When the threshold
// is exceeded, the agent loop injects a nudge suggesting the model use the
// ask_user tool to clarify with the user, instead of blindly retrying the
// rejected command.
//
// Flow:
//   1. preExec returns authorization='rejected' or 'blocked'
//   2. loop's wrapped onToolResult calls recordDenial()
//   3. After the stream round, shouldNudgeAfterDenials() is checked
//   4. If true, a nudge message is injected telling the model to use ask_user

const DENIAL_THRESHOLD = 3;
const MAX_DENIAL_NUDGES = 2; // cap nudges to avoid infinite loop

export interface DenialTracker {
  consecutiveDenials: number;
  totalDenials: number;
  nudgeCount: number;
  lastDeniedTool?: string;
  lastDeniedCommand?: string;
  lastDeniedReason?: string;
}

export function createDenialTracker(): DenialTracker {
  return {
    consecutiveDenials: 0,
    totalDenials: 0,
    nudgeCount: 0,
  };
}

// Record a denied authorization. Called when a tool result has
// authorization='rejected' or 'blocked'.
export function recordDenial(
  tracker: DenialTracker,
  toolName: string,
  reason?: string,
  command?: string,
): void {
  tracker.consecutiveDenials++;
  tracker.totalDenials++;
  tracker.lastDeniedTool = toolName;
  tracker.lastDeniedCommand = command;
  tracker.lastDeniedReason = reason;
}

// Reset the consecutive denial counter on a successful approval.
// totalDenials is NOT reset - it tracks the session total.
export function recordApproval(tracker: DenialTracker): void {
  tracker.consecutiveDenials = 0;
}

// Check if a denial nudge should be injected. If true, increments nudgeCount
// so the nudge is not repeated indefinitely.
export function shouldNudgeAfterDenials(
  tracker: DenialTracker,
): { shouldNudge: boolean; reason?: string } {
  if (
    tracker.consecutiveDenials >= DENIAL_THRESHOLD &&
    tracker.nudgeCount < MAX_DENIAL_NUDGES
  ) {
    tracker.nudgeCount++;
    const cmdInfo = tracker.lastDeniedCommand
      ? `（最近拒绝: ${tracker.lastDeniedCommand}）`
      : '';
    return {
      shouldNudge: true,
      reason: `已连续 ${tracker.consecutiveDenials} 次拒绝授权${cmdInfo}`,
    };
  }
  return { shouldNudge: false };
}

// Reset the denial nudge count (e.g., when the model successfully calls
// ask_user and the user provided direction).
export function resetDenialNudges(tracker: DenialTracker): void {
  tracker.nudgeCount = 0;
  tracker.consecutiveDenials = 0;
}
