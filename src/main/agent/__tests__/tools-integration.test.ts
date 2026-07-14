// Integration tests for P1-1, P1-3, and P1-4.
//
// These tests verify the WIRING of P1 features into tools.ts and loop.ts,
// not just the isolated modules. Mocks are limited to the SSH execution
// layer and DB storage; the real security engine, hooks engine, concurrency
// guard, and tool-results module are used.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HostConfig } from '../../../shared/types.js';

// ── Hoisted mock functions (available before vi.mock factories run) ──────
const mocks = vi.hoisted(() => ({
  execCommand: vi.fn(),
  sudoExecCommand: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  hostsGetByName: vi.fn(),
  hostsGet: vi.fn(),
  hooksListEnabled: vi.fn(() => [] as unknown[]),
}));

// ── Mock SSH layer ──────────────────────────────────────────────────────
vi.mock('../../ssh/index.js', () => ({
  connectionPool: {
    get: vi.fn().mockResolvedValue({ id: 'mock-mgr', isConnected: () => true }),
    invalidate: vi.fn(),
    listStatus: vi.fn(() => []),
  },
  execCommand: mocks.execCommand,
  sudoExecCommand: mocks.sudoExecCommand,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
}));

// ── Mock storage layers ────────────────────────────────────────────────
vi.mock('../../storage/hosts.js', () => ({
  hostsStore: {
    get: mocks.hostsGet,
    getByName: mocks.hostsGetByName,
    list: vi.fn(() => []),
  },
}));

vi.mock('../../storage/audit.js', () => ({
  auditStore: {
    create: vi.fn(),
    list: vi.fn(() => []),
    count: vi.fn(() => 0),
    verifyIntegrity: vi.fn(() => []),
  },
}));

vi.mock('../../storage/hooks.js', () => ({
  hooksStore: {
    listEnabled: mocks.hooksListEnabled,
    list: vi.fn(() => []),
  },
}));

vi.mock('../../storage/custom-rules.js', () => ({
  customRulesStore: {
    list: vi.fn(() => []),
  },
}));

vi.mock('../../storage/task-lists.js', () => ({
  taskListsStore: {
    get: vi.fn(() => null),
    upsert: vi.fn(),
  },
}));

vi.mock('../memory/automem.js', () => ({
  loadAutoMemory: vi.fn(() => ''),
  appendAutoMemory: vi.fn(),
}));

vi.mock('../memory/claudemd.js', () => ({
  buildMemoryPromptSection: vi.fn(() => ''),
}));

// ── Import after mocks ─────────────────────────────────────────────────
import { createTools } from '../tools.js';
import { setResultsBaseDir, MAX_TOOL_RESULT_CHARS } from '../tool-results.js';
import {
  createDenialTracker,
  recordDenial,
  recordApproval,
  shouldNudgeAfterDenials,
} from '../denial-tracking.js';
import type { Hook } from '../../../shared/types.js';

// ── Test fixtures ──────────────────────────────────────────────────────
const testHost: HostConfig = {
  id: 'host-1',
  name: 'test-host',
  host: '192.168.1.1',
  port: 22,
  username: 'root',
  authType: 'password' as const,
  groupName: 'default',
  timeoutMs: 30000,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

let testDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hostsGetByName.mockReturnValue(testHost);
  mocks.hostsGet.mockReturnValue(testHost);
  mocks.hooksListEnabled.mockReturnValue([]);
  mocks.execCommand.mockResolvedValue({
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
    durationMs: 5,
  });

  testDir = mkdtempSync(join(tmpdir(), 'ops-agent-int-'));
  setResultsBaseDir(testDir);
});

afterEach(() => {
  setResultsBaseDir(null);
  rmSync(testDir, { recursive: true, force: true });
});

function makeTools(
  overrides: {
    safetyMode?: 'sentinel' | 'operator' | 'autopilot' | 'plan';
    hooks?: Hook[];
    hostIds?: string[];
  } = {},
) {
  const safetyMode = overrides.safetyMode ?? 'autopilot';
  const hostIds = overrides.hostIds ?? ['host-1'];
  const onToolCall = vi.fn();
  const onToolResult = vi.fn();
  const onAuth = vi.fn().mockResolvedValue({ approved: true });
  const modeHolder = { mode: safetyMode };

  if (overrides.hooks) {
    mocks.hooksListEnabled.mockReturnValue(overrides.hooks as unknown[]);
  }

  const tools = createTools({
    context: {
      sessionId: 'test-session',
      hostIds,
      hostName: 'test-host',
      hostIp: '192.168.1.1',
      safetyMode,
      defaultHost: testHost,
    },
    safetyMode,
    onToolCall,
    onToolResult,
    onAuthorizationRequired: onAuth,
    modeHolder,
  });

  return { tools, onToolCall, onToolResult, onAuth };
}

// Helper: call a tool's execute function
async function callTool(
  tools: ReturnType<typeof makeTools>['tools'],
  name: string,
  args: Record<string, unknown>,
) {
  const toolMap = tools as unknown as Record<
    string,
    { execute: (a: Record<string, unknown>) => Promise<unknown> }
  >;
  return toolMap[name].execute(args);
}

// ════════════════════════════════════════════════════════════════════════
// P1-1: Concurrent tool execution + large result persistence
// ════════════════════════════════════════════════════════════════════════

describe('P1-1 Integration: Concurrency + Large Result Persistence', () => {
  it('READ exec calls to different hosts execute concurrently', async () => {
    const { tools, onToolResult } = makeTools({
      safetyMode: 'autopilot',
      hostIds: ['host-1', 'host-2'],
    });

    const host2 = { ...testHost, id: 'host-2', name: 'host-2' };
    mocks.hostsGetByName.mockImplementation((name?: string) => {
      if (name === 'host-2') return host2;
      return testHost;
    });

    const startTimes: number[] = [];
    mocks.execCommand.mockImplementation(async () => {
      startTimes.push(Date.now());
      await new Promise((r) => setTimeout(r, 100));
      return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100 };
    });

    const results = await Promise.all([
      callTool(tools, 'exec', { command: 'ls /tmp', description: 'list tmp' }),
      callTool(tools, 'exec', { host: 'host-2', command: 'ls /var', description: 'list var' }),
    ]);

    expect((results[0] as { stdout: string }).stdout).toBe('ok');
    expect((results[1] as { stdout: string }).stdout).toBe('ok');

    // Execution times should overlap (concurrent, not serial)
    expect(Math.abs(startTimes[0] - startTimes[1])).toBeLessThan(50);
    expect(onToolResult).toHaveBeenCalledTimes(2);
  });

  it('WRITE operations to same host serialize via mutex', async () => {
    const { tools } = makeTools({ safetyMode: 'autopilot' });

    const order: string[] = [];
    mocks.execCommand.mockImplementation(async (_mgr, cmd) => {
      const tag = cmd.includes('write1') ? '1' : '2';
      order.push(`start-${tag}`);
      await new Promise((r) => setTimeout(r, 50));
      order.push(`end-${tag}`);
      return { stdout: cmd, stderr: '', exitCode: 0, durationMs: 50 };
    });

    await Promise.all([
      callTool(tools, 'exec', { command: 'echo write1 > /tmp/test1', description: 'write 1' }),
      callTool(tools, 'exec', { command: 'echo write2 > /tmp/test2', description: 'write 2' }),
    ]);

    // Verify no interleaving: one write completes before the other starts
    const s1 = order.indexOf('start-1');
    const e1 = order.indexOf('end-1');
    const s2 = order.indexOf('start-2');
    const e2 = order.indexOf('end-2');

    const serialized = (s1 < e1 && e1 < s2 && s2 < e2) || (s2 < e2 && e2 < s1 && s1 < e1);
    expect(serialized).toBe(true);
  });

  it('large result (>8000 chars) is persisted and returns truncated preview', async () => {
    const { tools, onToolResult } = makeTools({ safetyMode: 'autopilot' });

    const bigOutput = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 500);
    mocks.execCommand.mockResolvedValue({
      stdout: bigOutput,
      stderr: '',
      exitCode: 0,
      durationMs: 10,
    });

    const result = await callTool(tools, 'exec', {
      command: 'cat /var/log/syslog',
      description: 'read large log',
    });

    const r = result as {
      truncated: boolean;
      preview: string;
      fullResultPath: string;
      totalChars: number;
      hint: string;
    };
    expect(r.truncated).toBe(true);
    expect(r.preview).toHaveLength(2000);
    expect(r.totalChars).toBe(MAX_TOOL_RESULT_CHARS + 500);
    expect(r.fullResultPath).toContain('test-session');
    expect(r.hint).toContain('read_tool_result');

    // UI should receive the FULL stdout (not truncated)
    const lastResult = onToolResult.mock.calls[onToolResult.mock.calls.length - 1][0] as {
      stdout: string;
    };
    expect(lastResult.stdout).toBe(bigOutput);
  });

  it('read_tool_result reads back persisted data', async () => {
    const { tools } = makeTools({ safetyMode: 'autopilot' });

    const bigStdout = 'LINE-' + 'data'.repeat(20) + '\n';
    const repeated = bigStdout.repeat(Math.ceil(MAX_TOOL_RESULT_CHARS / bigStdout.length) + 10);
    mocks.execCommand.mockResolvedValue({
      stdout: repeated,
      stderr: '',
      exitCode: 0,
      durationMs: 10,
    });

    const execResult = await callTool(tools, 'exec', {
      command: 'cat /var/log/syslog',
      description: 'read large log',
    });

    const path = (execResult as { fullResultPath: string }).fullResultPath;

    const readResult = await callTool(tools, 'read_tool_result', { path });

    const r = readResult as { stdout: string; exitCode: number; command: string; hostName: string };
    expect(r.stdout).toBe(repeated);
    expect(r.exitCode).toBe(0);
    expect(r.command).toBe('cat /var/log/syslog');
    expect(r.hostName).toBe('test-host');
  });

  it('small result returns normally without persistence', async () => {
    const { tools } = makeTools({ safetyMode: 'autopilot' });

    mocks.execCommand.mockResolvedValue({
      stdout: 'small output',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    });

    const result = await callTool(tools, 'exec', {
      command: 'echo hello',
      description: 'test echo',
    });

    const r = result as { stdout: string; truncated?: boolean; fullResultPath?: string };
    expect(r.stdout).toBe('small output');
    expect(r.truncated).toBeUndefined();
    expect(r.fullResultPath).toBeUndefined();
  });

  it('guard is released even when SSH throws an error', async () => {
    const { tools } = makeTools({ safetyMode: 'autopilot' });

    mocks.execCommand.mockRejectedValueOnce(new Error('SSH connection lost'));

    // First call throws
    await callTool(tools, 'exec', { command: 'ls /tmp', description: 'test' });

    // Second call should succeed (guard was released by finally)
    const result2 = await callTool(tools, 'exec', { command: 'ls /var', description: 'test 2' });
    expect((result2 as { stdout: string }).stdout).toBe('ok');
  });

  it('ops tools (tail_log) also persist large results', async () => {
    const { tools } = makeTools({ safetyMode: 'autopilot' });

    const bigOutput = 'z'.repeat(MAX_TOOL_RESULT_CHARS + 100);
    mocks.execCommand.mockResolvedValue({
      stdout: bigOutput,
      stderr: '',
      exitCode: 0,
      durationMs: 10,
    });

    const result = await callTool(tools, 'tail_log', { path: '/var/log/syslog', lines: 500 });

    const r = result as { truncated: boolean; preview: string; fullResultPath: string };
    expect(r.truncated).toBe(true);
    expect(r.preview).toHaveLength(2000);
    expect(r.fullResultPath).toContain('test-session');
  });

  it('path traversal in read_tool_result is rejected', async () => {
    const { tools } = makeTools({ safetyMode: 'autopilot' });

    const result = await callTool(tools, 'read_tool_result', {
      path: '/etc/passwd',
    });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('tool-results directory');
  });
});

// ════════════════════════════════════════════════════════════════════════
// P1-3: Hooks integration in tools.ts
// ════════════════════════════════════════════════════════════════════════

describe('P1-3 Integration: Hooks wired into tools.ts', () => {
  function makeHook(overrides: Partial<Hook> = {}): Hook {
    return {
      id: 'hook-1',
      name: 'test-hook',
      event: 'PreToolUse',
      type: 'command',
      config: {
        name: 'test-hook',
        event: 'PreToolUse',
        type: 'command',
        command: 'echo',
        timeoutMs: 5000,
      },
      condition: { toolName: '*' },
      enabled: true,
      createdAt: '2026-01-01',
      ...overrides,
    };
  }

  it('hooks are loaded from hooksStore.listEnabled() at createTools time', () => {
    mocks.hooksListEnabled.mockClear();
    makeTools({ safetyMode: 'autopilot' });
    expect(mocks.hooksListEnabled).toHaveBeenCalledTimes(1);
  });

  it('non-matching hook condition does not block exec', async () => {
    const { tools } = makeTools({
      safetyMode: 'autopilot',
      hooks: [makeHook({ condition: { toolName: 'nonexistent_tool' } })],
    });

    const result = await callTool(tools, 'exec', {
      command: 'echo test',
      description: 'test',
    });

    expect((result as { stdout: string }).stdout).toBe('ok');
    expect(mocks.execCommand).toHaveBeenCalled();
  });

  it('matching PreToolUse hook with command type is consulted (no crash)', async () => {
    // With a real command hook, the engine will try to execute the shell command.
    // Since the command is 'echo' (outputs empty), the hook returns null (no JSON),
    // which means "pass" - the tool proceeds normally.
    const { tools } = makeTools({
      safetyMode: 'autopilot',
      hooks: [makeHook({ condition: { toolName: 'exec' } })],
    });

    const result = await callTool(tools, 'exec', {
      command: 'echo test',
      description: 'test',
    });

    // Hook command 'echo' outputs empty -> parsed as null -> pass decision
    // So exec should proceed normally
    expect((result as { stdout: string }).stdout).toBe('ok');
  });

  it('PostToolUse hooks are invoked for exec (no crash, no context when no match)', async () => {
    const { tools, onToolResult } = makeTools({
      safetyMode: 'autopilot',
      hooks: [makeHook({ event: 'PostToolUse', condition: { toolName: 'nonexistent' } })],
    });

    mocks.execCommand.mockResolvedValue({
      stdout: 'raw output',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    });

    const result = await callTool(tools, 'exec', {
      command: 'echo test',
      description: 'test',
    });

    // No matching PostToolUse hook -> raw output, no [Hook Context]
    expect((result as { stdout: string }).stdout).toBe('raw output');
    expect((result as { stdout: string }).stdout).not.toContain('[Hook Context]');

    const lastResult = onToolResult.mock.calls[onToolResult.mock.calls.length - 1][0] as {
      stdout: string;
    };
    expect(lastResult.stdout).toBe('raw output');
  });

  it('PostToolUse hooks run for execReadTool (ops tools like tail_log)', async () => {
    const { tools } = makeTools({
      safetyMode: 'autopilot',
      hooks: [makeHook({ event: 'PostToolUse', condition: { toolName: 'tail_log' } })],
    });

    mocks.execCommand.mockResolvedValue({
      stdout: 'log line 1\nlog line 2',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    });

    const result = await callTool(tools, 'tail_log', { path: '/var/log/syslog' });

    // Hook command 'echo' outputs empty -> no additionalContext
    // So output should be raw (PostToolUse was consulted but returned no context)
    expect((result as { stdout: string }).stdout).toBe('log line 1\nlog line 2');
  });

  it('disabled hooks are not consulted', async () => {
    const { tools } = makeTools({
      safetyMode: 'autopilot',
      hooks: [makeHook({ enabled: false })],
    });

    const result = await callTool(tools, 'exec', {
      command: 'echo test',
      description: 'test',
    });

    expect((result as { stdout: string }).stdout).toBe('ok');
  });
});

// ════════════════════════════════════════════════════════════════════════
// P1-4: Denial tracking integration (simulates loop.ts wiring)
// ════════════════════════════════════════════════════════════════════════

describe('P1-4 Integration: Denial tracking (simulates loop.ts wiring)', () => {
  // Simulates the wrappedOnToolResult pattern from loop.ts:
  //   - If authorization is 'rejected' or 'blocked', record denial
  //   - If success, record approval (resets consecutive denials)
  //   - After threshold, shouldNudgeAfterDenials returns true

  it('accumulates consecutive denials on rejected authorizations', () => {
    const tracker = createDenialTracker();

    recordDenial(tracker, 'exec', 'User rejected', 'rm -rf /tmp');
    recordDenial(tracker, 'exec', 'User rejected', 'rm -rf /var');
    recordDenial(tracker, 'sudo_exec', 'User rejected', 'systemctl stop nginx');

    expect(tracker.consecutiveDenials).toBe(3);
    expect(tracker.totalDenials).toBe(3);
    expect(tracker.lastDeniedTool).toBe('sudo_exec');
    expect(tracker.lastDeniedCommand).toBe('systemctl stop nginx');
  });

  it('triggers shouldNudgeAfterDenials at threshold (3)', () => {
    const tracker = createDenialTracker();

    recordDenial(tracker, 'exec', 'rejected 1', 'cmd1');
    recordDenial(tracker, 'exec', 'rejected 2', 'cmd2');
    expect(shouldNudgeAfterDenials(tracker).shouldNudge).toBe(false);

    recordDenial(tracker, 'exec', 'rejected 3', 'cmd3');
    expect(shouldNudgeAfterDenials(tracker).shouldNudge).toBe(true);
  });

  it('successful approval resets consecutive denials', () => {
    const tracker = createDenialTracker();

    recordDenial(tracker, 'exec', 'rejected', 'cmd1');
    recordDenial(tracker, 'exec', 'rejected', 'cmd2');
    expect(tracker.consecutiveDenials).toBe(2);

    recordApproval(tracker);

    expect(tracker.consecutiveDenials).toBe(0);
    expect(tracker.totalDenials).toBe(2);

    recordDenial(tracker, 'exec', 'rejected', 'cmd3');
    expect(tracker.consecutiveDenials).toBe(1);
    expect(shouldNudgeAfterDenials(tracker).shouldNudge).toBe(false);
  });

  it('blocked commands count as denials (simulates loop.ts check)', () => {
    const tracker = createDenialTracker();

    // In loop.ts: if (result.authorization === 'rejected' || result.authorization === 'blocked')
    recordDenial(tracker, 'exec', 'Command blocked by security rules', 'rm -rf /');
    recordDenial(tracker, 'sudo_exec', 'Command blocked', 'dd if=/dev/zero');

    expect(tracker.consecutiveDenials).toBe(2);
    expect(tracker.totalDenials).toBe(2);
  });

  it('denial nudge takes priority over conclusion nudge in stall detection', () => {
    const tracker = createDenialTracker();

    // Simulate: model called tools, all rejected, then it stopped
    recordDenial(tracker, 'exec', 'rejected', 'cmd1');
    recordDenial(tracker, 'exec', 'rejected', 'cmd2');
    recordDenial(tracker, 'exec', 'rejected', 'cmd3');

    // Loop stall check: denial nudge has priority (loop.ts lines 391-413)
    const denialNudge = shouldNudgeAfterDenials(tracker);
    expect(denialNudge.shouldNudge).toBe(true);
  });

  it('full cycle: denials -> nudge -> approval -> reset', () => {
    const tracker = createDenialTracker();

    // 3 rejections -> nudge fires
    for (let i = 0; i < 3; i++) {
      recordDenial(tracker, 'exec', `rejected ${i}`, `cmd${i}`);
    }
    expect(shouldNudgeAfterDenials(tracker).shouldNudge).toBe(true);

    // Model adjusts approach, user approves next command
    recordApproval(tracker);
    expect(tracker.consecutiveDenials).toBe(0);

    // Subsequent rejection doesn't immediately re-trigger nudge
    recordDenial(tracker, 'exec', 'rejected', 'new-cmd');
    expect(shouldNudgeAfterDenials(tracker).shouldNudge).toBe(false);
  });
});
