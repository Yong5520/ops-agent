// Hook engine: executes PreToolUse and PostToolUse hooks.
//
// Design:
// - The engine accepts an executor function (dependency injection) so it's
//   fully testable without real subprocess/HTTP calls.
// - Production code uses `defaultExecutor` which dispatches to command-executor
//   or http-executor based on hook.type.
// - Fail open: timeout or error -> treated as pass (PreToolUse) or no-op (PostToolUse).
// - deny wins: first deny stops execution, subsequent hooks are not called.

import type { Hook, HookInput, HookPermissionDecision } from '../../../shared/types.js';
import { matchCondition } from './condition.js';
import { execCommandHook } from './command-executor.js';
import { execHttpHook } from './http-executor.js';
import { logger } from '../../utils/logger.js';

// What a hook returns (parsed from command stdout or HTTP response body).
export interface HookOutput {
  permissionDecision?: HookPermissionDecision;
  blockMessage?: string;
  modifiedToolInput?: Record<string, unknown>;
  additionalContext?: string;
}

// Executor: runs a single hook and returns its output (or null on no-op).
export type HookExecutor = (hook: Hook, input: HookInput) => Promise<HookOutput | null>;

export interface PreToolUseResult {
  decision: HookPermissionDecision;
  modifiedInput?: Record<string, unknown>;
  blockMessage?: string;
  additionalContext?: string;
}

export interface PostToolUseResult {
  additionalContext?: string;
}

// Default executor dispatches based on hook.type.
// Used by production code; tests inject a mock executor.
export const defaultExecutor: HookExecutor = async (hook, input) => {
  const timeoutMs = hook.config.timeoutMs ?? 30000;
  if (hook.type === 'command' && hook.config.command) {
    return execCommandHook(hook.config.command, input, timeoutMs);
  }
  if (hook.type === 'http' && hook.config.url) {
    return execHttpHook(hook.config, input);
  }
  return null;
};

// Execute PreToolUse hooks. Returns a decision:
// - deny: tool is blocked, blockMessage explains why (first deny stops)
// - allow: skip authorization, proceed directly
// - pass: continue normal flow (may include modifiedInput)
export async function executePreToolUseHooks(
  toolName: string,
  input: Record<string, unknown>,
  hooks: Hook[],
  executor: HookExecutor,
): Promise<PreToolUseResult> {
  const matching = hooks.filter(
    (h) => h.enabled && h.event === 'PreToolUse' && matchCondition(toolName, input, h.condition.toolName),
  );

  if (matching.length === 0) {
    return { decision: 'pass' };
  }

  let modifiedInput: Record<string, unknown> | undefined;
  let anyAllow = false;
  const contexts: string[] = [];

  for (const hook of matching) {
    const hookInput: HookInput = { ...hook, input };
    const output = await runWithTimeout(hook, hookInput, executor);

    if (!output) continue;

    if (output.permissionDecision === 'deny') {
      // First deny stops execution immediately
      return {
        decision: 'deny',
        blockMessage: output.blockMessage ?? `Blocked by hook: ${hook.name}`,
        additionalContext: contexts.join('\n') || undefined,
      };
    }

    if (output.permissionDecision === 'allow') {
      anyAllow = true;
    }

    if (output.modifiedToolInput) {
      modifiedInput = output.modifiedToolInput;
    }
    if (output.additionalContext) {
      contexts.push(output.additionalContext);
    }
  }

  return {
    decision: anyAllow ? 'allow' : 'pass',
    modifiedInput,
    additionalContext: contexts.join('\n') || undefined,
  };
}

// Execute PostToolUse hooks. Returns additionalContext to append to tool result.
export async function executePostToolUseHooks(
  toolName: string,
  input: Record<string, unknown>,
  result: { stdout?: string; stderr?: string; exitCode?: number | null },
  hooks: Hook[],
  executor: HookExecutor,
): Promise<PostToolUseResult> {
  const matching = hooks.filter(
    (h) => h.enabled && h.event === 'PostToolUse' && matchCondition(toolName, input, h.condition.toolName),
  );

  if (matching.length === 0) {
    return {};
  }

  const contexts: string[] = [];

  for (const hook of matching) {
    const hookInput: HookInput = { ...hook, input, result };
    const output = await runWithTimeout(hook, hookInput, executor);

    if (output?.additionalContext) {
      contexts.push(output.additionalContext);
    }
  }

  return {
    additionalContext: contexts.length > 0 ? contexts.join('\n') : undefined,
  };
}

// Run a single hook with timeout enforcement. Fail open on timeout/error.
async function runWithTimeout(
  hook: Hook,
  input: HookInput,
  executor: HookExecutor,
): Promise<HookOutput | null> {
  const timeoutMs = hook.config.timeoutMs ?? 30000;

  try {
    const result = await Promise.race([
      executor(hook, input),
      new Promise<null>((resolve) => setTimeout(() => {
        logger.warn(`[Hook] Hook "${hook.name}" timed out after ${timeoutMs}ms (fail open)`);
        resolve(null);
      }, timeoutMs)),
    ]);
    return result;
  } catch (err) {
    logger.error(`[Hook] Hook "${hook.name}" threw error (fail open): ${(err as Error).message}`);
    return null;
  }
}
