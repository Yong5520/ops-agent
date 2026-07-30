// Tests for the system-prompt meta-question rule (system-prompt.ts).
//
// When the user asks a question unrelated to the target host - e.g. "当前使用
// 多少的 token了", session cost, or the agent's own capabilities - the model
// must NOT start running host commands. The prompt must (a) name the
// get_session_usage tool as the way to answer usage questions, and (b) tell
// the model explicitly not to run host commands for such meta-questions. This
// is the prompt-side half of the gpu-16-36 incident fix.

import { describe, it, expect, vi } from 'vitest';

// buildSystemPrompt pulls in hostsStore, skills, and memory modules. Mock the
// storage/IO-backed ones so the test only exercises prompt assembly.
vi.mock('../../storage/hosts.js', () => ({
  hostsStore: { get: vi.fn(() => null), list: vi.fn(() => []) },
}));

vi.mock('../skills/index.js', () => ({
  getEnabledSkills: vi.fn(() => []),
}));

vi.mock('../memory/claudemd.js', () => ({
  buildMemoryPromptSection: vi.fn(() => ''),
}));

vi.mock('../memory/automem.js', () => ({
  loadAutoMemory: vi.fn(() => ''),
}));

import { buildSystemPrompt } from '../system-prompt.js';
import type { TodoItem } from '../../../shared/types.js';
import type { HostFacts } from '../facts.js';

describe('buildSystemPrompt: meta-question rule', () => {
  it('tells the model to answer token/cost meta-questions WITHOUT host commands', () => {
    const { staticPrefix } = buildSystemPrompt({
      selectedHostIds: [],
      safetyMode: 'operator',
    });

    // The rule must reference the get_session_usage tool by name.
    expect(staticPrefix).toContain('get_session_usage');
    // And must mention token/usage/cost as the meta-question trigger.
    expect(staticPrefix).toMatch(/token|用量|费用/);
    // And must forbid running host commands for such questions.
    expect(staticPrefix).toMatch(/禁止.*命令|不要.*执行命令|不.*对主机.*执行/);
  });
});

describe('buildSystemPrompt: task list resume injection', () => {
  const mixedTodos: TodoItem[] = [
    { id: '1', subject: '检查磁盘', description: '', status: 'completed' },
    { id: '2', subject: '分析日志', description: '', status: 'in_progress' },
    { id: '3', subject: '修复配置', description: '', status: 'pending' },
  ];

  it('injects the task list with status markers when todos are provided', () => {
    const { dynamicSuffix } = buildSystemPrompt({
      selectedHostIds: [],
      safetyMode: 'operator',
      todos: mixedTodos,
    });
    expect(dynamicSuffix).toContain('当前任务列表进度');
    expect(dynamicSuffix).toContain('[x] 已完成: 检查磁盘');
    expect(dynamicSuffix).toContain('[▶] 进行中: 分析日志');
    expect(dynamicSuffix).toContain('[ ] 待办: 修复配置');
  });

  it('adds a resume directive when there are incomplete steps', () => {
    const { dynamicSuffix } = buildSystemPrompt({
      selectedHostIds: [],
      safetyMode: 'operator',
      todos: mixedTodos,
    });
    expect(dynamicSuffix).toMatch(/不要重新创建任务列表/);
    expect(dynamicSuffix).toMatch(/续做|继续执行/);
  });

  it('does NOT add the resume directive when all steps are completed', () => {
    const { dynamicSuffix } = buildSystemPrompt({
      selectedHostIds: [],
      safetyMode: 'operator',
      todos: [{ id: '1', subject: 'done', description: '', status: 'completed' }],
    });
    expect(dynamicSuffix).toContain('所有步骤均已完成');
    expect(dynamicSuffix).not.toMatch(/不要重新创建任务列表/);
  });

  it('omits the task list section entirely when no todos are provided', () => {
    const { dynamicSuffix } = buildSystemPrompt({
      selectedHostIds: [],
      safetyMode: 'operator',
    });
    expect(dynamicSuffix).not.toContain('当前任务列表进度');
  });

  it('omits the task list section when todos is an empty array', () => {
    const { dynamicSuffix } = buildSystemPrompt({
      selectedHostIds: [],
      safetyMode: 'operator',
      todos: [],
    });
    expect(dynamicSuffix).not.toContain('当前任务列表进度');
  });
});

describe('buildSystemPrompt: host facts framing + scope adherence', () => {
  // Regression: host facts surfaced "⚠ 失败的 systemd 服务" which the agent
  // treated as an actionable task, investigating/fixing it even when the user
  // only asked a narrow query (e.g. `ls /home`). Failed services must be
  // framed as reference-only, without the actionable ⚠ marker.
  it('frames failed services as reference-only without actionable ⚠', () => {
    const hostFacts: HostFacts[] = [
      {
        hostId: 'h1',
        hostName: 'host-1',
        os: 'CentOS 7',
        kernel: '3.10.0',
        cpuCores: '8',
        memoryTotal: '16G',
        diskInfo: '/ 50G',
        failedUnits: ['gssproxy.service'],
        recentDmesg: [],
        cachedAt: 0,
      },
    ];
    const { dynamicSuffix } = buildSystemPrompt({
      selectedHostIds: [],
      safetyMode: 'operator',
      hostFacts,
    });
    expect(dynamicSuffix).toContain('gssproxy.service');
    expect(dynamicSuffix).not.toContain('⚠');
    expect(dynamicSuffix).toMatch(/仅供参考/);
  });

  it('includes a no-scope-extension rule for runtime-state items', () => {
    const { staticPrefix } = buildSystemPrompt({
      selectedHostIds: [],
      safetyMode: 'operator',
    });
    expect(staticPrefix).toMatch(/未经用户明确要求/);
    expect(staticPrefix).toMatch(/不.*延伸|不得.*展开调查/);
  });
});
