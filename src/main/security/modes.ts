import type { SafetyMode, CommandType } from '../../shared/types.js';

// Three-tier safety mode definition per PRD section 3.1.3.
//
// Sentinel  — diagnostic only. READ commands auto-run; everything else blocked.
// Operator  — standard. READ auto-runs; WRITE/SUDO require user confirmation.
// Autopilot — fully autonomous. All command types auto-run (still subject to
//             the security rule blocklist).

export interface ModeDecision {
  allowed: boolean;
  needsApproval: boolean;
  reason?: string;
}

// Decide whether a command of the given type may run in the given mode,
// and whether the user must approve it first.
// Rule-blocked commands (BLOCKED type) are rejected regardless of mode —
// the caller should have already run checkCommandSecurity and short-circuited.
export function decideByMode(mode: SafetyMode, commandType: CommandType): ModeDecision {
  switch (mode) {
    case 'sentinel':
      // Diagnostic mode: only READ allowed
      if (commandType === 'READ') {
        return { allowed: true, needsApproval: false };
      }
      return {
        allowed: false,
        needsApproval: false,
        reason: 'Sentinel 模式仅允许只读操作（READ）',
      };

    case 'operator':
      // Standard mode: READ auto, WRITE/SUDO need confirmation
      if (commandType === 'READ') {
        return { allowed: true, needsApproval: false };
      }
      return { allowed: true, needsApproval: true };

    case 'autopilot':
      // Fully autonomous
      return { allowed: true, needsApproval: false };

    case 'plan':
      // Plan mode: only READ allowed, WRITE/SUDO blocked.
      // The agent should use ExitPlanMode to get approval before executing.
      if (commandType === 'READ') {
        return { allowed: true, needsApproval: false };
      }
      return {
        allowed: false,
        needsApproval: false,
        reason:
          'Plan \u6a21\u5f0f\u4e0b\u7981\u6b62\u5199\u64cd\u4f5c\uff0c\u8bf7\u4f7f\u7528 exit_plan_mode \u63d0\u4ea4\u8ba1\u5212',
      };

    default: {
      // Exhaustive check — unknown mode is treated as strictest (sentinel)
      const exhaustive: never = mode;
      return {
        allowed: false,
        needsApproval: false,
        reason: `Unknown safety mode: ${String(exhaustive)}`,
      };
    }
  }
}

export const MODE_DESCRIPTIONS: Record<SafetyMode, { name: string; description: string }> = {
  sentinel: {
    name: '诊断模式 (Sentinel)',
    description: '严格只读。仅允许执行查询、诊断类命令。任何写入、修改、删除操作均被拦截。',
  },
  operator: {
    name: '标准模式 (Operator)',
    description: '允许全部操作，但写入类命令需用户逐条确认授权后才能执行。',
  },
  autopilot: {
    name: '自主模式 (Autopilot)',
    description: 'AI 可自行决定并执行全部命令，无需人工确认。仅适用于测试环境或完全信任的场景。',
  },
  plan: {
    name: '计划模式 (Plan)',
    description: '只读诊断。仅允许 READ 操作，完成诊断后需提交计划并经用户审批后方可执行写操作。',
  },
};
