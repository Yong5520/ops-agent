import { z } from 'zod';
import { tool } from 'ai';
import type { SafetyMode } from '../../../shared/types.js';

// ExitPlanMode tool - transitions from plan mode to execution mode.
//
// When the agent has completed its read-only diagnosis and formulated a plan,
// it calls this tool with the plan text. The tool:
//   1. Sends the plan to the renderer for user approval
//   2. Waits for the user's response (approve/reject/edit)
//   3. If approved: switches the session mode from 'plan' to 'operator'
//      so WRITE/SUDO tools become available
//   4. If rejected: returns to the model so it can revise the plan
//
// The mode switch is handled by updating the `modeHolder` object that
// preExec reads from, so the change takes effect immediately for
// subsequent tool calls in the same loop.

const ExitPlanModeInputSchema = z.object({
  plan: z
    .string()
    .min(1)
    .describe(
      'The structured plan text. Include: problem analysis, proposed steps, ' +
        'risk assessment, and verification approach.',
    ),
});

export type PlanApprovalResult = {
  approved: boolean;
  editedPlan?: string;
  reason?: string;
};

export type PlanApprovalCallback = (plan: string) => Promise<PlanApprovalResult>;

export type ModeHolder = { mode: SafetyMode };

// Callback to notify the renderer that the mode has changed.
// This is needed because exit_plan_mode changes the mode mid-loop,
// and the renderer's sessionStore must be updated so the NEXT loop
// starts in the correct mode.
export type ModeChangeCallback = (sessionId: string, newMode: SafetyMode) => void;

export function createExitPlanModeTool(
  sessionId: string,
  onPlanApproval: PlanApprovalCallback,
  modeHolder: ModeHolder,
  onModeChange?: ModeChangeCallback,
) {
  return tool({
    description:
      'Exit plan mode by submitting your plan for user approval. Call this when you have completed ' +
      'read-only diagnosis and formulated a concrete action plan. The user will review and approve/reject/edit. ' +
      'If approved, the session switches to operator mode and you can execute WRITE/SUDO operations. ' +
      'If rejected, revise your plan based on the feedback and call again.',
    parameters: ExitPlanModeInputSchema,
    execute: async ({
      plan,
    }): Promise<{
      approved: boolean;
      mode?: string;
      reason?: string;
      plan?: string;
    }> => {
      try {
        const result = await onPlanApproval(plan);

        if (result.approved) {
          // Switch mode from plan to operator
          modeHolder.mode = 'operator';

          // Persist the mode change to DB
          try {
            const { sessionsStore } = await import('../../storage/sessions.js');
            sessionsStore.updateSession(sessionId, { safetyMode: 'operator' });
          } catch {
            // Non-fatal: mode switch in memory is sufficient for this loop
          }

          // Notify renderer to update its store (P0-1.B fix: state desync)
          onModeChange?.(sessionId, 'operator');

          return {
            approved: true,
            mode: 'operator',
            plan: result.editedPlan ?? plan,
          };
        }

        return {
          approved: false,
          reason: result.reason ?? 'User rejected the plan. Please revise and resubmit.',
          plan: result.editedPlan,
        };
      } catch (err) {
        return {
          approved: false,
          reason: `Plan approval failed: ${(err as Error).message}`,
        };
      }
    },
  });
}
