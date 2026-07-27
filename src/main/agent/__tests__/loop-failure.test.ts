// Tests for the loop's failure-handling path (Fix A: context pollution).
//
// When a turn fails BEFORE any assistant text is produced (e.g. the model
// endpoint is unreachable), the loop MUST save a "failure marker" assistant
// message so the failed turn is closed in the conversation history. Otherwise
// the unanswered user message becomes an orphan that the model treats as a
// pending task on the NEXT turn - causing it to re-run the failed task
// instead of answering the new question.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  // Captures every assistant message saved by the loop so we can assert on
  // what gets persisted to the (mocked) DB.
  savedAssistantMessages: [] as Array<{ sessionId: string; content: string }>,
  streamTextThrow: null as Error | null,
  // Counts how many times streamText was called - to verify fast-fail
  // (connect-timeout must NOT trigger the retry cycle).
  streamTextCallCount: 0,
}));

// Mock the AI SDK. streamText returns an object whose fullStream is an async
// iterable that yields an 'error' part - this is how the real SDK surfaces a
// connect-timeout (the call doesn't throw synchronously; the error arrives
// during stream iteration, which is where loop.ts's retry logic lives).
function makeStreamTextErrorPart(errorMessage: string) {
  return {
    fullStream: (async function* () {
      yield { type: 'error', error: new Error(errorMessage) };
    })(),
    response: Promise.resolve({ messages: [] }),
  };
}

vi.mock('ai', () => ({
  streamText: (..._args: unknown[]) => {
    mocks.streamTextCallCount++;
    if (mocks.streamTextThrow) {
      if (mocks.streamTextThrow.name === 'AbortError') throw mocks.streamTextThrow;
      return makeStreamTextErrorPart(mocks.streamTextThrow.message);
    }
    throw new Error('streamText mock not configured');
  },
}));

vi.mock('../providers.js', () => ({
  // The loop now resolves a provider (per-session override -> global default)
  // then builds a LanguageModel from it. Both are mocked: resolveModelProvider
  // returns a minimal provider, createLanguageModel returns a model id.
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
  }),
  createLanguageModel: () => ({ modelId: 'mock-model' }),
  validateModelExists: vi.fn(),
  // Kept for any other code path still importing getActiveModel (compact
  // handler, etc.) - harmless if unused in this test.
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

// Import AFTER mocks are registered.
import { runAgentLoop } from '../loop.js';
import type { AgentLoopParams } from '../types.js';

// Minimal params: the loop fails before invoking most callbacks, so stubs
// suffice. Cast through unknown to satisfy TS without listing every field.
const baseParams = {
  sessionId: 'sess-test',
  userMessage: '使用 numa1 再进行测试一次',
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

describe('loop failure path (Fix A: failure marker)', () => {
  beforeEach(() => {
    mocks.savedAssistantMessages = [];
    mocks.streamTextThrow = null;
    mocks.streamTextCallCount = 0;
  });

  it('saves a failure-marker assistant message when the endpoint is unreachable and no text was produced', async () => {
    // Simulate the exact error from the bug report: connect timeout.
    mocks.streamTextThrow = new Error(
      'Failed after 3 attempts. Last error: Cannot connect to API: Connect Timeout Error',
    );

    const onError = vi.fn();
    const onComplete = vi.fn();
    await runAgentLoop(makeParams({ onError, onComplete }));

    // A failure marker assistant message MUST be persisted so the failed
    // turn is closed in history (not left as an orphan user message).
    expect(mocks.savedAssistantMessages.length).toBeGreaterThanOrEqual(1);
    const marker = mocks.savedAssistantMessages[0]!;
    expect(marker.sessionId).toBe('sess-test');
    // The marker must indicate failure (not be empty / not contain tool output).
    expect(marker.content.length).toBeGreaterThan(0);
    expect(marker.content).toMatch(/失败|未能|错误|无法/);
  });

  it('does NOT save a failure marker twice (idempotent on a single failure)', async () => {
    mocks.streamTextThrow = new Error('Cannot connect to API: Connect Timeout Error');
    await runAgentLoop(makeParams({}));

    // Exactly one assistant message (the failure marker) - not zero, not many.
    expect(mocks.savedAssistantMessages).toHaveLength(1);
  });

  it('still calls onError so the UI surfaces the error', async () => {
    mocks.streamTextThrow = new Error('Cannot connect to API: Connect Timeout Error');
    const onError = vi.fn();
    await runAgentLoop(makeParams({ onError }));

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('saves a cancellation marker when aborted with no partial text', async () => {
    // Abort before any text streams: AbortError surfaces from streamText.
    // Same orphan-message risk as the failure path - must save a marker.
    mocks.streamTextThrow = new Error('Aborted');
    // Make the error look like an AbortError.
    Object.defineProperty(mocks.streamTextThrow, 'name', { value: 'AbortError' });

    const abortController = new AbortController();
    abortController.abort();

    await runAgentLoop(makeParams({ abortSignal: abortController.signal }));

    // A cancellation marker must be saved so the aborted turn is closed.
    expect(mocks.savedAssistantMessages.length).toBeGreaterThanOrEqual(1);
    const marker = mocks.savedAssistantMessages[mocks.savedAssistantMessages.length - 1]!;
    expect(marker.content).toMatch(/取消|已取消|abort/i);
  });

  it('fails fast on connect-timeout without retrying (Fix B)', async () => {
    // Connect Timeout = host is dead. The loop must NOT spend ~2 min on the
    // retry cycle (the bug report shows retries at 13:18:39 and 13:19:20,
    // ~40s apart). It should fail on the first attempt.
    mocks.streamTextThrow = new Error(
      'Failed after 3 attempts. Last error: Cannot connect to API: Connect Timeout Error',
    );

    const onError = vi.fn();
    const start = Date.now();
    await runAgentLoop(makeParams({ onError }));
    const elapsed = Date.now() - start;

    // Should fail within a few seconds (no 2-min retry cycle). Generous
    // upper bound to avoid flakiness on slow CI.
    expect(elapsed).toBeLessThan(10_000);
    expect(onError).toHaveBeenCalledTimes(1);
    // streamText must be called only ONCE - no retry on connect-timeout.
    expect(mocks.streamTextCallCount).toBe(1);
    // The error message must guide the user toward the unreachable endpoint.
    const errMsg = (onError.mock.calls[0]![0] as Error).message;
    expect(errMsg).toMatch(/无法连接|端点|网络/i);
  });
});

describe('loop failure path: model-error tagging (功能 2)', () => {
  beforeEach(() => {
    mocks.savedAssistantMessages = [];
    mocks.streamTextThrow = null;
    mocks.streamTextCallCount = 0;
  });

  it('tags a model-API error (connect timeout) as "模型异常" in onError', async () => {
    // The user must see clearly that THIS failure is a model problem, not a
    // generic exception. The "模型异常" label distinguishes it from SSH/tool
    // failures ("执行异常").
    mocks.streamTextThrow = new Error(
      'Failed after 3 attempts. Last error: Cannot connect to API: Connect Timeout Error',
    );
    const onError = vi.fn();
    await runAgentLoop(makeParams({ onError }));

    const errMsg = (onError.mock.calls[0]![0] as Error).message;
    expect(errMsg).toContain('模型异常');
    // Must still carry the friendly "无法连接" detail.
    expect(errMsg).toContain('无法连接');
    // And point toward Settings -> Test connection.
    expect(errMsg).toMatch(/设置|测试连接/);
  });

  it('tags a 401 invalid-key error as "模型异常"', async () => {
    mocks.streamTextThrow = new Error('Unauthorized: invalid api key');
    const onError = vi.fn();
    await runAgentLoop(makeParams({ onError }));

    const errMsg = (onError.mock.calls[0]![0] as Error).message;
    expect(errMsg).toContain('模型异常');
    expect(errMsg).toContain('API Key');
  });

  it('saves a failure-marker assistant message carrying the "模型异常" tag', async () => {
    // The persisted marker (visible in chat history) must also be tagged so
    // a user reviewing history understands the failure was model-side.
    mocks.streamTextThrow = new Error('Cannot connect to API: Connect Timeout Error');
    await runAgentLoop(makeParams({}));

    const marker = mocks.savedAssistantMessages[0]!;
    expect(marker.content).toContain('模型异常');
  });
});
