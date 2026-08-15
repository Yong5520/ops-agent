// Tests for the Phase 3 "steer" path in loop.ts.
//
// While a run is executing, the user can type a message to redirect the task.
// The renderer enqueues it via agent:steer; the loop drains the queue
// (params.consumeSteerMessages) and injects each entry's text as a user message
// before the next streamText round, so the model sees the user's mid-task input.
// After draining, the loop calls params.onSteerConsumed so the renderer can move
// those queued steers from the pending queue into the message list.
//
// This file reuses the loop-wind-down mock harness (streamText is mocked; the
// loop doesn't execute real tools).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SteerEntry } from '../../../shared/types.js';

const mocks = vi.hoisted(() => ({
  savedUserMessages: [] as Array<{ sessionId: string; content: string }>,
  savedAssistantMessages: [] as Array<{ sessionId: string; content: string }>,
  streamTextCallCount: 0,
  capturedMessages: [] as Array<unknown[]>,
  scriptedStreams: null as Array<Array<{ type: string; [k: string]: unknown }>> | null,
  // Scripted steer queue contents returned by each consumeSteerMessages call.
  scriptedSteers: null as Array<SteerEntry[]> | null,
  steerCallIndex: 0,
}));

function makeStream(parts: Array<{ type: string; [k: string]: unknown }>) {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
    response: Promise.resolve({ messages: [{ role: 'assistant', content: 'round-response' }] }),
  };
}

vi.mock('ai', () => ({
  streamText: (opts: { messages?: unknown[] }) => {
    mocks.streamTextCallCount++;
    mocks.capturedMessages.push(opts.messages ?? []);
    if (mocks.scriptedStreams && mocks.scriptedStreams.length > 0) {
      return makeStream(mocks.scriptedStreams.shift()!);
    }
    throw new Error('streamText mock not configured');
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
vi.mock('../tools.js', () => ({ createTools: () => ({}) }));
vi.mock('../system-prompt.js', () => ({
  buildSystemPrompt: () => ({ staticPrefix: '', dynamicSuffix: '' }),
}));
vi.mock('../context.js', () => ({
  loadMessages: () => [],
  compressContext: async (m: unknown[]) => m,
  buildMessagesForCall: (_h: unknown[], userMessage: string) => [
    { role: 'user', content: userMessage },
  ],
  saveUserMessage: (sessionId: string, content: string) => {
    mocks.savedUserMessages.push({ sessionId, content });
    return 'user-msg-id';
  },
  saveAssistantMessage: (sessionId: string, content: string) => {
    mocks.savedAssistantMessages.push({ sessionId, content });
  },
  getContextWindowForModel: () => 80000,
  compactMessages: (m: unknown[]) => m,
  estimateTokens: () => 100,
}));
vi.mock('../token-budget.js', () => ({
  createBudgetTracker: () => ({ contextWindow: 80000, totalTokensUsed: 0, continuationCount: 0 }),
  updateBudget: vi.fn(),
}));
vi.mock('../stall-detection.js', () => ({
  evaluateStallDecision: () => ({ shouldNudge: false, reason: 'substantive' }),
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
vi.mock('../loop-repetition-guard.js', () => ({ detectRepetition: () => null }));
vi.mock('../cost-tracking.js', () => ({ extractUsage: () => null }));
vi.mock('../../storage/cost-store.js', () => ({ recordSessionCost: vi.fn() }));
vi.mock('../tools/exit-plan-mode.js', () => ({}));
vi.mock('../../storage/hosts.js', () => ({ hostsStore: { get: vi.fn(() => null) } }));
vi.mock('../../storage/models.js', () => ({ modelsStore: { getActive: vi.fn(() => null) } }));
vi.mock('../facts.js', () => ({ gatherMultipleHostFacts: async () => [] }));
vi.mock('../../storage/attachments.js', () => ({ attachmentsStore: { save: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runAgentLoop } from '../loop.js';
import type { AgentLoopParams } from '../types.js';

const baseParams = {
  sessionId: 'sess-steer',
  userMessage: '排查 nginx 服务',
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
    onSteerConsumed: vi.fn(),
    ...overrides,
  } as unknown as AgentLoopParams;
}

function steer(msgId: string, text: string): SteerEntry {
  return { msgId, text };
}

describe('Phase 3: steer message injection', () => {
  beforeEach(() => {
    mocks.savedUserMessages = [];
    mocks.savedAssistantMessages = [];
    mocks.streamTextCallCount = 0;
    mocks.capturedMessages = [];
    mocks.scriptedStreams = null;
    mocks.scriptedSteers = null;
    mocks.steerCallIndex = 0;
  });

  it('injects a queued steer as a user message into the next streamText round', async () => {
    // Round 1: model produces a substantive response (finish=stop, no tools).
    // post-stream: substantive exit -> the loop checks the steer queue.
    mocks.scriptedStreams = [
      [
        { type: 'text-delta', textDelta: '正在排查...' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ],
      // Round 2: model responds to the steer.
      [
        { type: 'text-delta', textDelta: '好的，改用方法 Y。' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ],
    ];
    // Steer queue: empty on the first drain (top of round 1), then a steer is
    // queued (returned on the substantive-exit drain), then empty.
    const queued = steer('msg-steer-1', '别重启 nginx，先看日志');
    mocks.scriptedSteers = [
      [], // round 1 top-drain
      [queued], // round 1 exit-drain (steer arrived mid-round)
      [], // round 2 top-drain
      [], // round 2 exit-drain
    ];
    const consumeSteer = () => {
      const next = mocks.scriptedSteers?.[mocks.steerCallIndex++] ?? [];
      return next;
    };
    const onSteerConsumed = vi.fn();

    await runAgentLoop(makeParams({ consumeSteerMessages: consumeSteer, onSteerConsumed }));

    // Two streamText rounds: original + steer.
    expect(mocks.streamTextCallCount).toBe(2);
    // The steer text must appear in the second round's messages.
    const secondMessages = mocks.capturedMessages[1] as Array<{ content?: string }>;
    const hasSteer = secondMessages.some(
      (m) => typeof m?.content === 'string' && m.content.includes('别重启 nginx'),
    );
    expect(hasSteer).toBe(true);
    // The loop does NOT persist the steer (the IPC steer handler saves it when
    // queueing). Only the initial user message is saved by the loop.
    expect(mocks.savedUserMessages).toHaveLength(1);
    expect(mocks.savedUserMessages[0].content).toBe('排查 nginx 服务');
    // The loop notified the caller that the queued steer was fed to the model
    // (so the renderer can move it from the pending queue into the message list).
    expect(onSteerConsumed).toHaveBeenCalledTimes(1);
    expect(onSteerConsumed).toHaveBeenCalledWith([queued]);
  });

  it('does not inject a steer when none is queued (normal single-round run)', async () => {
    mocks.scriptedStreams = [
      [
        { type: 'text-delta', textDelta: '完成。' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ],
    ];
    mocks.scriptedSteers = [[], []];
    const consumeSteer = () => mocks.scriptedSteers?.[mocks.steerCallIndex++] ?? [];
    const onSteerConsumed = vi.fn();

    await runAgentLoop(makeParams({ consumeSteerMessages: consumeSteer, onSteerConsumed }));

    expect(mocks.streamTextCallCount).toBe(1);
    // Only the initial user message was saved, no steer.
    expect(mocks.savedUserMessages).toHaveLength(1);
    // No steers drained -> onSteerConsumed never fires.
    expect(onSteerConsumed).not.toHaveBeenCalled();
  });

  it('drains a top-of-round steer and notifies onSteerConsumed before the round', async () => {
    // Steer is already queued when round 1 starts (top-drain path).
    mocks.scriptedStreams = [
      [
        { type: 'text-delta', textDelta: '采纳你的建议。' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ],
    ];
    const queued = steer('msg-steer-top', '用方法 Y');
    mocks.scriptedSteers = [
      [queued], // round 1 top-drain
      [], // round 1 exit-drain
    ];
    const consumeSteer = () => mocks.scriptedSteers?.[mocks.steerCallIndex++] ?? [];
    const onSteerConsumed = vi.fn();

    await runAgentLoop(makeParams({ consumeSteerMessages: consumeSteer, onSteerConsumed }));

    // The steer text appears in the (single) round's messages.
    const firstMessages = mocks.capturedMessages[0] as Array<{ content?: string }>;
    expect(
      firstMessages.some((m) => typeof m?.content === 'string' && m.content.includes('用方法 Y')),
    ).toBe(true);
    expect(onSteerConsumed).toHaveBeenCalledTimes(1);
    expect(onSteerConsumed).toHaveBeenCalledWith([queued]);
  });
});
