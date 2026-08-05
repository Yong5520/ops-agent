// Tests for the Phase B "拒绝并停止" wind-down path in loop.ts.
//
// When the user rejects a command via "拒绝并停止", preExec sets
// stopRequestedRef.current = true. The loop's stream consumer breaks, and the
// post-stream logic injects WIND_DOWN_DIRECTIVE as a user message and runs one
// more streamText round so the agent can summarize + ask the user how to
// proceed (instead of continuing to propose commands).
//
// This file uses its own mock harness (the loop mock doesn't execute real
// tools, so stopRequestedRef is injected via params and set mid-stream by the
// scripted stream to simulate the rejection).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted state ───────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  savedAssistantMessages: [] as Array<{ sessionId: string; content: string }>,
  streamTextCallCount: 0,
  // Messages passed to each streamText call (captured to assert the wind-down
  // directive is injected before the second call).
  capturedMessages: [] as Array<unknown[]>,
  // Per-call scripted stream parts.
  scriptedStreams: null as Array<Array<{ type: string; [k: string]: unknown }>> | null,
  // Injected stopRequestedRef - set to true mid-stream by the first scripted
  // stream to simulate the user clicking "拒绝并停止".
  stopRequestedRef: { current: false },
}));

function makeStream(parts: Array<{ type: string; [k: string]: unknown }>) {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
    response: Promise.resolve({ messages: [] }),
  };
}

vi.mock('ai', () => ({
  streamText: (opts: { messages?: unknown[] }) => {
    mocks.streamTextCallCount++;
    mocks.capturedMessages.push(opts.messages ?? []);
    if (mocks.scriptedStreams && mocks.scriptedStreams.length > 0) {
      return makeStream(mocks.scriptedStreams.shift()!);
    }
    throw new Error('streamText mock not configured: set mocks.scriptedStreams');
  },
}));

vi.mock('../providers.js', () => ({
  resolveModelProvider: () => ({
    id: 'mock',
    name: 'mock',
    type: 'openai-compatible',
    endpoint: 'http://mock/v1',
    apiKey: 'mock-key',
    modelName: 'mock-model',
    contextWindow: 80000,
    isActive: true,
    createdAt: '',
    updatedAt: '',
    inputPricePerMTok: 3,
    outputPricePerMTok: 15,
  }),
  createLanguageModel: () => ({ modelId: 'mock-model' }),
  validateModelExists: vi.fn(),
  getActiveModel: () => ({ modelId: 'mock-model' }),
}));

vi.mock('../tools.js', () => ({
  createTools: () => ({}),
}));

vi.mock('../system-prompt.js', () => ({
  buildSystemPrompt: () => ({ staticPrefix: '', dynamicSuffix: '' }),
}));

vi.mock('../context.js', () => ({
  loadMessages: () => [],
  compressContext: async (m: unknown[]) => m,
  buildMessagesForCall: () => [],
  saveUserMessage: vi.fn(() => 'user-msg-id'),
  saveAssistantMessage: (sessionId: string, content: string) => {
    mocks.savedAssistantMessages.push({ sessionId, content });
  },
  getContextWindowForModel: () => 80000,
  compactMessages: (m: unknown[]) => m,
  estimateTokens: () => 100,
}));

vi.mock('../token-budget.js', () => ({
  createBudgetTracker: () => ({
    contextWindow: 80000,
    totalTokensUsed: 0,
    continuationCount: 0,
  }),
  updateBudget: vi.fn(),
}));

vi.mock('../stall-detection.js', () => ({
  evaluateStallDecision: () => ({ shouldNudge: false, reason: 'no_tools' }),
}));

vi.mock('../thinking-stream.js', () => ({
  createThinkingStream: () => ({
    feedTextDelta: vi.fn(),
    feedReasoningDelta: vi.fn(),
    closeCurrent: vi.fn(),
  }),
}));

vi.mock('../denial-tracking.js', () => ({
  createDenialTracker: () => ({ consecutiveDenials: 0, lastDeniedCommand: '' }),
  recordDenial: vi.fn(),
  recordApproval: vi.fn(),
  shouldNudgeAfterDenials: () => ({ shouldNudge: false }),
}));

vi.mock('../loop-repetition-guard.js', () => ({
  detectRepetition: () => null,
}));

vi.mock('../cost-tracking.js', () => ({
  extractUsage: () => null,
}));

vi.mock('../../storage/cost-store.js', () => ({
  recordSessionCost: vi.fn(),
}));

vi.mock('../tools/exit-plan-mode.js', () => ({}));

vi.mock('../../storage/hosts.js', () => ({
  hostsStore: { get: vi.fn(() => null) },
}));

vi.mock('../../storage/models.js', () => ({
  modelsStore: { getActive: vi.fn(() => null) },
}));

vi.mock('../facts.js', () => ({
  gatherMultipleHostFacts: async () => [],
}));

vi.mock('../../storage/attachments.js', () => ({
  attachmentsStore: { save: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { runAgentLoop } from '../loop.js';
import type { AgentLoopParams } from '../types.js';

const baseParams = {
  sessionId: 'sess-winddown',
  userMessage: '清理 /tmp 下的日志',
  hostIds: ['host-1'],
  safetyMode: 'operator' as const,
  abortSignal: undefined as undefined | AbortSignal,
};

function makeParams(overrides: Partial<AgentLoopParams>): AgentLoopParams {
  return {
    ...baseParams,
    onTextStream: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onAuthorizationRequired: vi.fn(),
    onError: vi.fn(),
    onComplete: vi.fn(),
    ...overrides,
  } as unknown as AgentLoopParams;
}

describe('Phase B: 拒绝并停止 wind-down path', () => {
  beforeEach(() => {
    mocks.savedAssistantMessages = [];
    mocks.streamTextCallCount = 0;
    mocks.capturedMessages = [];
    mocks.scriptedStreams = null;
    mocks.stopRequestedRef.current = false;
  });

  it('runs a wind-down turn with the directive after stop is requested', async () => {
    // Round 1: the for-await breaks immediately because stopRequestedRef is
    // already true (set below) - simulating the user having just clicked
    // "拒绝并停止" mid-stream. The finish part is never consumed.
    mocks.scriptedStreams = [
      [
        { type: 'text-delta', textDelta: '正在清理...' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ],
      // Round 2 (wind-down): model summarizes and stops.
      [
        { type: 'text-delta', textDelta: '好的，已停止。请告诉我如何继续。' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ],
    ];

    // Set stopRequestedRef before the loop runs. The for-await's top-of-loop
    // check breaks on the first iteration, exercising the wind-down path.
    mocks.stopRequestedRef.current = true;

    await runAgentLoop(makeParams({ stopRequestedRef: mocks.stopRequestedRef }));

    // Two streamText calls: original (broken) + wind-down.
    expect(mocks.streamTextCallCount).toBe(2);
    // The second call's messages must include the wind-down directive.
    const secondCallMessages = mocks.capturedMessages[1] as Array<{ content?: string }>;
    const hasDirective = secondCallMessages.some(
      (m) => typeof m?.content === 'string' && m.content.includes('停止执行命令'),
    );
    expect(hasDirective).toBe(true);
    // The loop completed (saved an assistant message), didn't error into a loop.
    expect(mocks.savedAssistantMessages).toHaveLength(1);
  });

  it('does not loop forever: exits after the wind-down turn', async () => {
    // stopRef set before round 1 -> wind-down runs round 2 -> windDownDone
    // forces exit. No third call.
    mocks.scriptedStreams = [
      [
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ],
      [
        { type: 'text-delta', textDelta: '已停止。' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ],
    ];
    mocks.stopRequestedRef.current = true;

    await runAgentLoop(makeParams({ stopRequestedRef: mocks.stopRequestedRef }));

    expect(mocks.streamTextCallCount).toBe(2);
  });
});
