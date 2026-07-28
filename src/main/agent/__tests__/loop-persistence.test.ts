// Integration test for the orphan-task bug (loop persistence path).
//
// Reproduces the exact failure from the gpu-16-36 session: a conclusion-nudge
// round appends "\n\n" to fullText, then the model finishes with no
// substantive text. The loop MUST persist a marker message, NOT the bare
// "\n\n". A whitespace-only assistant message reads as an unfinished turn, so
// the next user question (e.g. "当前使用了多少的 token了") gets treated as a
// continuation of the prior pending host task - the agent resumes running
// disk/container commands instead of answering.
//
// This file uses its own mock harness (separate from loop-failure.test.ts)
// because reproducing the nudge path requires stall-detection to actually
// return shouldNudge:true, which the loop-failure harness deliberately mocks
// to false.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted state ───────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  savedAssistantMessages: [] as Array<{ sessionId: string; content: string }>,
  streamTextCallCount: 0,
  // Per-call scripted stream parts. Each entry is an array of parts yielded
  // by one streamText call. Shifted off in order.
  scriptedStreams: null as Array<Array<{ type: string; [k: string]: unknown }>> | null,
}));

// Build a streamText return value whose fullStream yields the given parts.
function makeStream(parts: Array<{ type: string; [k: string]: unknown }>) {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
    response: Promise.resolve({ messages: [] }),
  };
}

vi.mock('ai', () => ({
  streamText: () => {
    mocks.streamTextCallCount++;
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

// Stall detection: nudge when tools were called but no text was produced
// (empty stall) - this is what drives fullText += "\n\n" in the real bug.
vi.mock('../stall-detection.js', () => ({
  evaluateStallDecision: (input: { toolCallCount: number }) =>
    input.toolCallCount > 0
      ? { shouldNudge: true, reason: 'empty_stall' }
      : { shouldNudge: false, reason: 'no_tools' },
}));

vi.mock('../thinking-stream.js', () => ({
  // No-op feedTextDelta: roundText stays '' regardless of text-deltas, so the
  // ONLY way fullText becomes non-empty is the nudge's fullText += "\n\n".
  // This isolates the nudge-path bug.
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
  sessionId: 'sess-orphan',
  userMessage: '当前使用了多少的 token了',
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

describe('loop persistence: whitespace-only fullText (orphan-task bug)', () => {
  beforeEach(() => {
    mocks.savedAssistantMessages = [];
    mocks.streamTextCallCount = 0;
    mocks.scriptedStreams = null;
  });

  it('does NOT persist a whitespace-only message after a nudge round (saves a marker)', async () => {
    // Round 1: tool call + stop with no text -> empty-stall -> nudge appends
    // "\n\n" to fullText and re-runs.
    // Round 2: stop with no tools -> loop exits with fullText === "\n\n".
    // Pre-fix: site 1 did `if (fullText)` (truthy) and saved "\n\n".
    // Post-fix: hasSubstantiveText("\n\n") === false -> saves a marker.
    mocks.scriptedStreams = [
      [
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'exec', args: {} },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ],
      [
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ],
    ];

    await runAgentLoop(makeParams({}));

    expect(mocks.streamTextCallCount).toBe(2);
    expect(mocks.savedAssistantMessages).toHaveLength(1);
    const saved = mocks.savedAssistantMessages[0]!;
    // The exact bug: content must NOT be the bare "\n\n".
    expect(saved.content).not.toBe('\n\n');
    // It must be a real, non-whitespace marker that closes the turn.
    expect(saved.content.trim().length).toBeGreaterThan(0);
  });
});
