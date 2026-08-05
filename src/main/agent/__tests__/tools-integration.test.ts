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
  // connectionPool.get mock - default returns a generic manager. Per-host
  // tests (V3-08 exec_multi) override this to return a manager carrying the
  // host id so execCommand-mock can distinguish hosts.
  poolGet: vi.fn().mockResolvedValue({ id: 'mock-mgr', isConnected: () => true }),
}));

// ── Mock SSH layer ──────────────────────────────────────────────────────
vi.mock('../../ssh/index.js', () => ({
  connectionPool: {
    get: mocks.poolGet,
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

// Mock the cost store so the get_session_usage tool can be tested without a DB.
vi.mock('../../storage/cost-store.js', () => ({
  getSessionCostTotal: vi.fn(() => ({
    promptTokens: 1500,
    completionTokens: 300,
    totalTokens: 1800,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedUsd: 0.009,
  })),
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
import { auditStore } from '../../storage/audit.js';
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
  agentForward: false,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

let testDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hostsGetByName.mockReturnValue(testHost);
  mocks.hostsGet.mockReturnValue(testHost);
  mocks.hooksListEnabled.mockReturnValue([]);
  // L2 fix: reset poolGet to the default generic manager. makeMultiHostTools
  // overrides this per-test; without the reset, that per-host impl would leak
  // into later describe blocks (clearAllMocks does not reset implementations).
  mocks.poolGet.mockResolvedValue({ id: 'mock-mgr', isConnected: () => true });
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
    stopRequestedRef?: { current: boolean };
  } = {},
) {
  const safetyMode = overrides.safetyMode ?? 'autopilot';
  const hostIds = overrides.hostIds ?? ['host-1'];
  const onToolCall = vi.fn();
  const onToolResult = vi.fn();
  const onAuth = vi.fn().mockResolvedValue({ approved: true });
  const modeHolder = { mode: safetyMode };
  const stopRequestedRef = overrides.stopRequestedRef ?? { current: false };

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
    stopRequestedRef,
  });

  return { tools, onToolCall, onToolResult, onAuth, stopRequestedRef };
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
    // V3-06: preview is now head + tail (not head-only), so no exact-length
    // assertion. It must start with the head chars and be bounded.
    expect(r.preview.startsWith('x')).toBe(true);
    expect(r.preview.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
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
    // V3-06: preview is head + tail now; assert it's bounded and head-starts.
    expect(r.preview.startsWith('z')).toBe(true);
    expect(r.preview.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
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

  // ── V3-07: ops tools stream output incrementally ──────────────────────
  // execReadTool (used by tail_log/search_logs/journal_query) previously called
  // execCommand WITHOUT the onStream callback, so a `tail -f` or long-running
  // grep blocked until the host timeout with nothing shown to the user. Now it
  // must forward the onStream callback and emit partial:true onToolResult
  // chunks - same pattern as exec/sudo_exec (tools.ts:549-562).
  it('V3-07: tail_log streams incremental output via partial onToolResult chunks', async () => {
    const { tools, onToolResult } = makeTools({ safetyMode: 'autopilot' });

    // Mock execCommand to invoke its 3rd-arg onStream callback with two chunks,
    // then resolve with the full accumulated result.
    mocks.execCommand.mockImplementation(async (_mgr, _cmd, onStream) => {
      onStream?.({ stream: 'stdout', data: 'line-1\n' });
      onStream?.({ stream: 'stdout', data: 'line-2\n' });
      return { stdout: 'line-1\nline-2\n', stderr: '', exitCode: 0, durationMs: 10 };
    });

    await callTool(tools, 'tail_log', { path: '/var/log/syslog', lines: 50 });

    // At least two partial chunks must have been emitted to the UI.
    const partialCalls = onToolResult.mock.calls.map((c) => c[0]).filter((r) => r.partial === true);
    expect(partialCalls.length).toBeGreaterThanOrEqual(2);
    // The streamed chunk data must carry the stdout content.
    expect(partialCalls.some((r) => r.stdout === 'line-1\n')).toBe(true);
    expect(partialCalls.some((r) => r.stdout === 'line-2\n')).toBe(true);
  });

  // ── V3-07 Cycle B: stop_tail cancels an in-flight command ─────────────
  it('V3-07: stop_tail reports stopped:false for an unknown toolCallId', async () => {
    const { tools } = makeTools({ safetyMode: 'autopilot' });

    const result = await callTool(tools, 'stop_tail', { toolCallId: 'never-running' });
    expect(result).toMatchObject({ stopped: false });
  });

  it('V3-07: stop_tail aborts a running tail_log via its toolCallId', async () => {
    const { tools, onToolCall } = makeTools({ safetyMode: 'autopilot' });

    // Mock execCommand to stream one chunk, then block on the abort signal.
    // When stop_tail fires the AbortController, the signal listener resolves
    // and execCommand returns the partial output (mirroring the real abort path).
    mocks.execCommand.mockImplementation(async (_mgr, _cmd, onStream, signal) => {
      onStream?.({ stream: 'stdout', data: 'partial-line\n' });
      if (signal?.aborted) {
        return {
          stdout: 'partial-line\n',
          stderr: '',
          exitCode: null,
          durationMs: 5,
          aborted: true,
        };
      }
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { stdout: 'partial-line\n', stderr: '', exitCode: null, durationMs: 5, aborted: true };
    });

    // Start tail_log - it registers an AbortController and blocks on the signal.
    const tailPromise = callTool(tools, 'tail_log', { path: '/var/log/syslog', follow: true });

    // Wait for the tool to register (onToolCall fires before execCommand blocks).
    await new Promise((r) => setTimeout(r, 50));
    const tailCallId = onToolCall.mock.calls[onToolCall.mock.calls.length - 1][0].toolCallId;

    // stop_tail with the real toolCallId -> stopped:true, and the registry
    // aborts the controller, unblocking tail_log.
    const stopResult = await callTool(tools, 'stop_tail', { toolCallId: tailCallId });
    expect(stopResult).toMatchObject({ stopped: true });

    // tail_log now resolves with the partial output.
    const result = await tailPromise;
    expect(result).toMatchObject({ stdout: 'partial-line\n' });
  });
});

// ════════════════════════════════════════════════════════════════════════
// V3-08: exec_multi batch multi-host
// ════════════════════════════════════════════════════════════════════════
describe('V3-08 Integration: exec_multi batch multi-host', () => {
  const host1: HostConfig = { ...testHost, id: 'host-1', name: 'web-1' };
  const host2: HostConfig = { ...testHost, id: 'host-2', name: 'web-2' };

  function makeMultiHostTools(safetyMode: 'autopilot' | 'sentinel' = 'autopilot') {
    // hostsGet returns the right host per id; hostsGetByName resolves by name.
    mocks.hostsGet.mockImplementation((id: string) =>
      id === 'host-1' ? host1 : id === 'host-2' ? host2 : null,
    );
    mocks.hostsGetByName.mockImplementation((name: string) =>
      name === 'web-1' ? host1 : name === 'web-2' ? host2 : undefined,
    );
    // poolGet returns a manager carrying the requested host id, so the
    // execCommand mock can distinguish which host it is running on.
    mocks.poolGet.mockImplementation(async (hostId: string) => ({
      id: hostId,
      isConnected: () => true,
    }));
    return makeTools({ safetyMode, hostIds: ['host-1', 'host-2'] });
  }

  it('fans out a READ command to all session hosts and aggregates results', async () => {
    const { tools } = makeMultiHostTools();
    mocks.execCommand.mockResolvedValue({
      stdout: 'disk: 80%',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    });

    const result = (await callTool(tools, 'exec_multi', {
      command: 'df -h /',
      description: 'check disk on all web hosts',
    })) as {
      byHost: Record<string, { ok: boolean; stdout: string }>;
      totalCount: number;
      successCount: number;
      failedCount: number;
      divergent: boolean;
    };

    // Ran on both hosts in parallel.
    expect(mocks.execCommand).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      totalCount: 2,
      successCount: 2,
      failedCount: 0,
      divergent: false,
    });
    expect(result.byHost['web-1']).toMatchObject({ ok: true, stdout: 'disk: 80%' });
    expect(result.byHost['web-2']).toMatchObject({ ok: true, stdout: 'disk: 80%' });
  });

  it('a host failure does not abort the others (allSettled)', async () => {
    const { tools } = makeMultiHostTools();
    // web-1 succeeds, web-2 throws a connection error.
    mocks.execCommand.mockImplementation(async (mgr) => {
      const hostId = (mgr as { id?: string }).id;
      if (hostId === 'host-2') throw new Error('SSH connection lost');
      return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 5 };
    });

    const result = (await callTool(tools, 'exec_multi', {
      command: 'uptime',
      description: 'check uptime on all hosts',
    })) as {
      byHost: Record<string, { ok: boolean }>;
      totalCount: number;
      successCount: number;
      failedCount: number;
    };

    expect(result).toMatchObject({ totalCount: 2, successCount: 1, failedCount: 1 });
    expect(result.byHost['web-1'].ok).toBe(true);
    expect(result.byHost['web-2'].ok).toBe(false);
  });

  it('flags divergent outputs across succeeding hosts', async () => {
    const { tools } = makeMultiHostTools();
    mocks.execCommand.mockImplementation(async (mgr) => {
      const hostId = (mgr as { id?: string }).id;
      return {
        stdout: hostId === 'host-1' ? 'active' : 'inactive',
        stderr: '',
        exitCode: 0,
        durationMs: 5,
      };
    });

    const result = (await callTool(tools, 'exec_multi', {
      command: 'systemctl is-active nginx',
      description: 'compare nginx state across hosts',
    })) as { divergent: boolean; distinctOutputCount: number };

    expect(result.divergent).toBe(true);
    expect(result.distinctOutputCount).toBe(2);
  });

  it('rejects WRITE commands (READ-only in this cut)', async () => {
    const { tools } = makeMultiHostTools();
    // A write-like command the classifier will flag as WRITE/SUDO/BLOCKED.
    // `rm` is a destructive write command.
    const result = await callTool(tools, 'exec_multi', {
      command: 'rm /tmp/file',
      description: 'remove a file on all hosts',
    });

    expect(result).toMatchObject({ error: expect.any(String), blocked: true });
  });

  it('targets an explicit host subset when hosts[] is provided', async () => {
    const { tools } = makeMultiHostTools();
    mocks.execCommand.mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    });

    const result = (await callTool(tools, 'exec_multi', {
      command: 'hostname',
      hosts: ['web-1'],
      description: 'check one host only',
    })) as { totalCount: number };

    expect(mocks.execCommand).toHaveBeenCalledTimes(1);
    expect(result.totalCount).toBe(1);
  });

  it('V3-08 H1: a host-specific security block is honored per-host (not bypassed)', async () => {
    // host-2 has a host-specific blocked rule that host-1 lacks. The global
    // pre-check (targets[0] = host-1) passes, but the per-host re-check inside
    // the fan-out must block host-2 - it must NOT execute there.
    // NOTE: securityConfig is captured at createTools time (getEffectiveConfig
    // reads customRulesStore.list), so the rule mock MUST be set before makeTools.
    const { customRulesStore } = await import('../../storage/custom-rules.js');
    (customRulesStore as { list: () => unknown[] }).list = vi.fn(() => [
      {
        id: 'rule-host2-block',
        name: 'block host-2 df',
        type: 'blocked',
        pattern: 'df',
        commandType: 'BLOCKED',
        hostId: 'host-2', // host-specific override (engine.ts hostOverrides)
        enabled: true,
        createdAt: '2026-01-01',
      },
    ]);

    const { tools } = makeMultiHostTools();
    let host2Executed = false;
    mocks.execCommand.mockImplementation(async (mgr) => {
      const hostId = (mgr as { id?: string }).id;
      if (hostId === 'host-2') host2Executed = true;
      return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 5 };
    });

    const result = (await callTool(tools, 'exec_multi', {
      command: 'df -h /',
      description: 'disk check',
    })) as {
      byHost: Record<string, { ok: boolean; stderr: string }>;
      successCount: number;
      failedCount: number;
    };

    expect(host2Executed).toBe(false); // H1: host-2 was NOT executed
    expect(result.byHost['web-2'].ok).toBe(false);
    expect(result.byHost['web-2'].stderr).toMatch(/blocked/i);
    expect(result.byHost['web-1'].ok).toBe(true);
    expect(result.failedCount).toBe(1);
    expect(result.successCount).toBe(1);
  });

  it('V3-08 M2: unknown host names in hosts[] are surfaced as skippedHosts', async () => {
    const { tools } = makeMultiHostTools();
    mocks.execCommand.mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    });

    const result = (await callTool(tools, 'exec_multi', {
      command: 'hostname',
      hosts: ['web-1', 'typo-host'],
      description: 'check hosts',
    })) as { skippedHosts: string[]; totalCount: number };

    expect(result.totalCount).toBe(1); // only web-1 ran
    expect(result.skippedHosts).toContain('typo-host');
  });

  it('V3-08 L1: duplicate host names are deduped (run once, not twice)', async () => {
    const { tools } = makeMultiHostTools();
    mocks.execCommand.mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    });

    const result = (await callTool(tools, 'exec_multi', {
      command: 'hostname',
      hosts: ['web-1', 'web-1'],
      description: 'dedupe check',
    })) as { totalCount: number };

    expect(mocks.execCommand).toHaveBeenCalledTimes(1); // deduped, not 2
    expect(result.totalCount).toBe(1);
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

  it('triggers shouldNudgeAfterDenials at threshold (2)', () => {
    const tracker = createDenialTracker();

    recordDenial(tracker, 'exec', 'rejected 1', 'cmd1');
    expect(shouldNudgeAfterDenials(tracker).shouldNudge).toBe(false);

    recordDenial(tracker, 'exec', 'rejected 2', 'cmd2');
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

// ════════════════════════════════════════════════════════════════════════
// V3-01: get_session_usage tool (meta-question escape hatch)
// ════════════════════════════════════════════════════════════════════════

describe('get_session_usage tool', () => {
  it('returns cumulative token usage + estimated cost for the session', async () => {
    const { tools } = makeTools({ safetyMode: 'sentinel' });

    const result = (await callTool(tools, 'get_session_usage', {})) as {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      estimatedUsd: number;
    };

    // Mirrors the mocked getSessionCostTotal return value.
    expect(result.promptTokens).toBe(1500);
    expect(result.completionTokens).toBe(300);
    expect(result.totalTokens).toBe(1800);
    expect(result.estimatedUsd).toBeCloseTo(0.009, 6);
  });

  it('is available even in sentinel (read-only) mode - it touches no host', async () => {
    // A meta-question tool must work regardless of safety mode: it never
    // executes anything on a remote host, so sentinel's READ-only restriction
    // must not block it. No authorization should be requested.
    const { tools, onAuth, onToolCall } = makeTools({ safetyMode: 'sentinel' });

    await callTool(tools, 'get_session_usage', {});

    // A meta tool touches no host, so neither authorization nor tool-call
    // notifications should fire.
    expect(onAuth).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// Phase A/B: command editing in approval + rejection feedback
// ════════════════════════════════════════════════════════════════════════
describe('Phase A/B: command editing + rejection feedback', () => {
  it('executes the user-edited command when the user edits and approves', async () => {
    const { tools, onAuth } = makeTools({ safetyMode: 'operator' });
    onAuth.mockResolvedValue({ approved: true, editedCommand: 'echo bar > /tmp/y' });

    await callTool(tools, 'exec', {
      command: 'echo foo > /tmp/x',
      description: 'write test',
    });

    // The EDITED command (not the original) reaches the SSH layer.
    expect(mocks.execCommand).toHaveBeenCalledTimes(1);
    expect(mocks.execCommand.mock.calls[0][1]).toBe('echo bar > /tmp/y');
    // Audit records the executed command + editedByUser flag.
    expect(auditStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'echo bar > /tmp/y',
        editedByUser: true,
      }),
    );
  });

  it('does not execute when the edited command hits a blocked rule', async () => {
    const { tools, onAuth } = makeTools({ safetyMode: 'operator' });
    onAuth.mockResolvedValue({ approved: true, editedCommand: 'rm -rf /' });

    const result = (await callTool(tools, 'exec', {
      command: 'echo foo > /tmp/x',
      description: 'write test',
    })) as { error?: string; blocked?: boolean };

    expect(mocks.execCommand).not.toHaveBeenCalled();
    expect(result.blocked).toBe(true);
    expect(result.error).toContain('安全规则');
    // Audit records the block with the BLOCKED commandType.
    expect(auditStore.create).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: 'blocked', commandType: 'BLOCKED' }),
    );
  });

  it('returns strong, instructional feedback to the model on a plain reject', async () => {
    const { tools, onAuth } = makeTools({ safetyMode: 'operator' });
    onAuth.mockResolvedValue({ approved: false, reason: '用户拒绝' });

    const result = (await callTool(tools, 'exec', {
      command: 'echo foo > /tmp/x',
      description: 'write test',
    })) as { error?: string; blocked?: boolean };

    expect(mocks.execCommand).not.toHaveBeenCalled();
    expect(result.blocked).toBe(true);
    // Model-facing error names the rejected command and directs to ask_user.
    expect(result.error).toContain('echo foo > /tmp/x');
    expect(result.error).toContain('ask_user');
    expect(result.error).toContain('请勿重复尝试');
  });

  it('sets stopRequestedRef when the user rejects via "拒绝并停止"', async () => {
    const stopRequestedRef = { current: false };
    const { tools, onAuth } = makeTools({ safetyMode: 'operator', stopRequestedRef });
    onAuth.mockResolvedValue({
      approved: false,
      stopRequested: true,
      reason: '用户拒绝并要求停止',
    });

    const result = (await callTool(tools, 'exec', {
      command: 'echo foo > /tmp/x',
      description: 'write test',
    })) as { error?: string };

    expect(stopRequestedRef.current).toBe(true);
    expect(result.error).toContain('停止当前任务');
  });

  it('treats an unchanged edit (same as original) as a no-op', async () => {
    const { tools, onAuth } = makeTools({ safetyMode: 'operator' });
    onAuth.mockResolvedValue({ approved: true, editedCommand: 'echo foo > /tmp/x' });

    await callTool(tools, 'exec', {
      command: 'echo foo > /tmp/x',
      description: 'write test',
    });

    expect(mocks.execCommand).toHaveBeenCalledTimes(1);
    expect(mocks.execCommand.mock.calls[0][1]).toBe('echo foo > /tmp/x');
    // editedByUser should NOT be set when the edit equals the original.
    expect(auditStore.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ editedByUser: true }),
    );
  });

  it('informs the model when a command was user-edited (returns the executed command + notice)', async () => {
    // Bug: the edited command executes, but the tool result returned to the
    // model didn't mention the edit - so the model's subsequent steps
    // referenced the ORIGINAL command. The result must surface the edit.
    const { tools, onAuth } = makeTools({ safetyMode: 'operator' });
    onAuth.mockResolvedValue({ approved: true, editedCommand: 'mkdir /var/log/app2' });

    const result = (await callTool(tools, 'exec', {
      command: 'mkdir /var/log/app',
      description: 'create dir',
    })) as { stdout?: string; command?: string; userEdited?: boolean };

    // The EDITED command ran (not the original).
    expect(mocks.execCommand.mock.calls[0][1]).toBe('mkdir /var/log/app2');
    // The model is informed via a stdout notice referencing the edited command.
    expect(result.stdout).toContain('mkdir /var/log/app2');
    expect(result.stdout).toContain('修改');
    // Structured fields for the model.
    expect(result.command).toBe('mkdir /var/log/app2');
    expect(result.userEdited).toBe(true);
  });

  it('does not add edit notice/fields when the command was not edited', async () => {
    const { tools, onAuth } = makeTools({ safetyMode: 'operator' });
    onAuth.mockResolvedValue({ approved: true }); // no editedCommand

    const result = (await callTool(tools, 'exec', {
      command: 'echo foo > /tmp/x',
      description: 'write',
    })) as { stdout?: string; command?: string; userEdited?: boolean };

    expect(result.userEdited).toBeUndefined();
    expect(result.command).toBeUndefined();
    // stdout is the raw mock output, no edit notice.
    expect(result.stdout).not.toContain('修改');
  });
});
