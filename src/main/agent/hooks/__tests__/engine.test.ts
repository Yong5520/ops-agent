import { describe, it, expect } from 'vitest';
import {
  executePreToolUseHooks,
  executePostToolUseHooks,
  type HookExecutor,
  type HookOutput,
} from '../engine.js';
import type { Hook } from '../../../../shared/types.js';

function makeHook(overrides: Partial<Hook> = {}): Hook {
  return {
    id: 'h1',
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

// Helper: create an executor that returns a fixed output for any hook.
function fixedExecutor(output: HookOutput | null): HookExecutor {
  return async () => output;
}

// Helper: create an executor that returns specific outputs per hook id.
function mappedExecutor(map: Record<string, HookOutput | null>): HookExecutor {
  return async (hook: Hook) => map[hook.id] ?? null;
}

// Helper: create an executor that throws.
function throwingExecutor(error: Error): HookExecutor {
  return async () => {
    throw error;
  };
}

// Helper: create an executor that never resolves within test timeframe.
function slowExecutor(delayMs: number): HookExecutor {
  return async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return null;
  };
}

describe('executePreToolUseHooks', () => {
  it('returns pass when no hooks provided', async () => {
    const result = await executePreToolUseHooks('exec', { command: 'ls' }, [], fixedExecutor(null));
    expect(result.decision).toBe('pass');
  });

  it('returns pass when no matching hooks (disabled or wrong event)', async () => {
    const hooks = [
      makeHook({ id: 'h1', enabled: false }),
      makeHook({ id: 'h2', event: 'PostToolUse' }),
    ];
    const result = await executePreToolUseHooks(
      'exec',
      { command: 'ls' },
      hooks,
      fixedExecutor(null),
    );
    expect(result.decision).toBe('pass');
  });

  it('returns pass when no hooks match the condition', async () => {
    const hooks = [makeHook({ id: 'h1', condition: { toolName: 'write_file' } })];
    const result = await executePreToolUseHooks(
      'exec',
      { command: 'ls' },
      hooks,
      fixedExecutor(null),
    );
    expect(result.decision).toBe('pass');
  });

  it('returns deny when hook returns deny', async () => {
    const hooks = [makeHook({ id: 'h1' })];
    const executor = fixedExecutor({ permissionDecision: 'deny', blockMessage: 'blocked by hook' });
    const result = await executePreToolUseHooks('exec', { command: 'rm -rf /' }, hooks, executor);
    expect(result.decision).toBe('deny');
    expect(result.blockMessage).toBe('blocked by hook');
  });

  it('returns allow when hook returns allow', async () => {
    const hooks = [makeHook({ id: 'h1' })];
    const executor = fixedExecutor({ permissionDecision: 'allow' });
    const result = await executePreToolUseHooks('exec', { command: 'ls' }, hooks, executor);
    expect(result.decision).toBe('allow');
  });

  it('returns pass when hook returns pass', async () => {
    const hooks = [makeHook({ id: 'h1' })];
    const executor = fixedExecutor({ permissionDecision: 'pass' });
    const result = await executePreToolUseHooks('exec', { command: 'ls' }, hooks, executor);
    expect(result.decision).toBe('pass');
  });

  it('returns modifiedInput when hook returns modifiedToolInput', async () => {
    const hooks = [makeHook({ id: 'h1' })];
    const executor = fixedExecutor({
      permissionDecision: 'pass',
      modifiedToolInput: { command: 'ls --safe' },
    });
    const result = await executePreToolUseHooks('exec', { command: 'ls' }, hooks, executor);
    expect(result.decision).toBe('pass');
    expect(result.modifiedInput).toEqual({ command: 'ls --safe' });
  });

  it('deny wins over allow when multiple hooks match', async () => {
    const hooks = [makeHook({ id: 'h1' }), makeHook({ id: 'h2' })];
    const executor = mappedExecutor({
      h1: { permissionDecision: 'allow' },
      h2: { permissionDecision: 'deny', blockMessage: 'denied by h2' },
    });
    const result = await executePreToolUseHooks('exec', { command: 'ls' }, hooks, executor);
    expect(result.decision).toBe('deny');
    expect(result.blockMessage).toBe('denied by h2');
  });

  it('first deny stops execution (subsequent hooks not called)', async () => {
    const hooks = [makeHook({ id: 'h1' }), makeHook({ id: 'h2' }), makeHook({ id: 'h3' })];
    let h3Called = false;
    const executor: HookExecutor = async (hook: Hook) => {
      if (hook.id === 'h1') return { permissionDecision: 'deny', blockMessage: 'first deny' };
      if (hook.id === 'h3') h3Called = true;
      return { permissionDecision: 'allow' };
    };
    const result = await executePreToolUseHooks('exec', { command: 'ls' }, hooks, executor);
    expect(result.decision).toBe('deny');
    expect(h3Called).toBe(false);
  });

  it('treats hook timeout as pass (fail open)', async () => {
    const hooks = [
      makeHook({
        id: 'h1',
        config: {
          name: 'test',
          event: 'PreToolUse',
          type: 'command',
          command: 'sleep',
          timeoutMs: 50,
        },
      }),
    ];
    const executor = slowExecutor(5000);
    const result = await executePreToolUseHooks('exec', { command: 'ls' }, hooks, executor);
    expect(result.decision).toBe('pass');
  });

  it('treats hook error as pass (fail open)', async () => {
    const hooks = [makeHook({ id: 'h1' })];
    const executor = throwingExecutor(new Error('hook crashed'));
    const result = await executePreToolUseHooks('exec', { command: 'ls' }, hooks, executor);
    expect(result.decision).toBe('pass');
  });

  it('returns null output when hook returns null (treated as pass)', async () => {
    const hooks = [makeHook({ id: 'h1' })];
    const executor = fixedExecutor(null);
    const result = await executePreToolUseHooks('exec', { command: 'ls' }, hooks, executor);
    expect(result.decision).toBe('pass');
  });
});

describe('executePostToolUseHooks', () => {
  function makePostHook(overrides: Partial<Hook> = {}): Hook {
    return makeHook({ event: 'PostToolUse', ...overrides });
  }

  it('returns empty additionalContext when no hooks', async () => {
    const result = await executePostToolUseHooks(
      'exec',
      { command: 'ls' },
      { stdout: '', stderr: '', exitCode: 0 },
      [],
      fixedExecutor(null),
    );
    expect(result.additionalContext).toBeUndefined();
  });

  it('appends additionalContext from hook', async () => {
    const hooks = [makePostHook({ id: 'h1' })];
    const executor = fixedExecutor({ additionalContext: 'monitoring alert sent' });
    const result = await executePostToolUseHooks(
      'exec',
      { command: 'ls' },
      { stdout: 'done', stderr: '', exitCode: 0 },
      hooks,
      executor,
    );
    expect(result.additionalContext).toBe('monitoring alert sent');
  });

  it('concatenates additionalContext from multiple hooks', async () => {
    const hooks = [makePostHook({ id: 'h1' }), makePostHook({ id: 'h2' })];
    const executor = mappedExecutor({
      h1: { additionalContext: 'alert1' },
      h2: { additionalContext: 'alert2' },
    });
    const result = await executePostToolUseHooks(
      'exec',
      { command: 'ls' },
      { stdout: '', stderr: '', exitCode: 0 },
      hooks,
      executor,
    );
    expect(result.additionalContext).toContain('alert1');
    expect(result.additionalContext).toContain('alert2');
  });

  it('treats hook timeout as fail open (no additionalContext)', async () => {
    const hooks = [
      makePostHook({
        id: 'h1',
        config: {
          name: 'test',
          event: 'PostToolUse',
          type: 'command',
          command: 'sleep',
          timeoutMs: 50,
        },
      }),
    ];
    const executor = slowExecutor(5000);
    const result = await executePostToolUseHooks(
      'exec',
      { command: 'ls' },
      { stdout: '', stderr: '', exitCode: 0 },
      hooks,
      executor,
    );
    expect(result.additionalContext).toBeUndefined();
  });

  it('treats hook error as fail open', async () => {
    const hooks = [makePostHook({ id: 'h1' })];
    const executor = throwingExecutor(new Error('crash'));
    const result = await executePostToolUseHooks(
      'exec',
      { command: 'ls' },
      { stdout: '', stderr: '', exitCode: 0 },
      hooks,
      executor,
    );
    expect(result.additionalContext).toBeUndefined();
  });
});
