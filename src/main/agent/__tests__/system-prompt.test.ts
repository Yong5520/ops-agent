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
