// Tests for testProviderConnection: the backend behind the "测试连接" button.
//
// These pin down three things the user complained about:
//   1. The probe must use a maxTokens large enough for reasoning/thinking
//      models (glm-5.2 etc.) - maxTokens=1 makes those 400. We use 16.
//   2. On failure the returned error must include BOTH a friendly hint AND
//      the raw underlying cause, so the user can actually diagnose it
//      (e.g. "fetch failed: ECONNREFUSED" not just "无法连接").
//   3. On success it returns ok + latencyMs.
//
// generateText is mocked - we are testing the wrapper logic, not the network.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const generateTextMock = vi.hoisted(() => vi.fn());

vi.mock('ai', () => ({
  generateText: generateTextMock,
}));

// Silence logger in test output.
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { testProviderConnection } from '../providers.js';
import type { ModelProvider } from '../../../shared/types.js';

function anthropicProvider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: 'p1',
    name: 'Test',
    type: 'anthropic',
    endpoint: '',
    apiKey: 'sk-test',
    modelName: 'claude-sonnet-4-6',
    isActive: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('testProviderConnection', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('returns ok + latencyMs when the probe succeeds', async () => {
    generateTextMock.mockResolvedValue({} as never);
    const result = await testProviderConnection(anthropicProvider());
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('probes with maxTokens=16 (not 1) so reasoning/thinking models do not 400', async () => {
    // glm-5.2 and other reasoning models count thinking tokens against
    // max_tokens; max_tokens=1 makes them reject the request. 16 is enough
    // to get past the minimum while staying cheap for a connectivity probe.
    generateTextMock.mockResolvedValue({} as never);
    await testProviderConnection(anthropicProvider());
    const callArg = generateTextMock.mock.calls[0]![0] as { maxTokens: number };
    expect(callArg.maxTokens).toBe(16);
  });

  it('passes a 15s abort timeout so a dead endpoint cannot hang the UI', async () => {
    generateTextMock.mockResolvedValue({} as never);
    await testProviderConnection(anthropicProvider());
    const callArg = generateTextMock.mock.calls[0]![0] as { abortSignal?: AbortSignal };
    expect(callArg.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('returns friendly hint + raw cause on a network error', async () => {
    generateTextMock.mockRejectedValue(new Error('fetch failed'));
    const result = await testProviderConnection(anthropicProvider());
    expect(result.ok).toBe(false);
    // Friendly classification
    expect(result.error).toContain('无法连接');
    // AND the raw underlying cause so the user can diagnose it
    expect(result.error).toContain('fetch failed');
  });

  it('returns friendly hint + raw cause on a 401', async () => {
    generateTextMock.mockRejectedValue(new Error('Unauthorized: invalid api key'));
    const result = await testProviderConnection(anthropicProvider());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('API Key');
    expect(result.error).toContain('Unauthorized');
  });

  it('returns friendly hint + raw cause on a 5xx', async () => {
    generateTextMock.mockRejectedValue(new Error('HTTP 503 Service Unavailable'));
    const result = await testProviderConnection(anthropicProvider());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('服务端错误');
    expect(result.error).toContain('503');
  });

  it('surfaces an unmatched error verbatim when no friendly pattern matches', async () => {
    generateTextMock.mockRejectedValue(new Error('something totally unexpected'));
    const result = await testProviderConnection(anthropicProvider());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('something totally unexpected');
  });
});

describe('testProviderConnection - SDK-bypass fallback', () => {
  // glm-5.2 (and similar) return response bodies the SDK refuses to parse
  // ("Invalid JSON response" / "signature" validation errors). The connection
  // is actually healthy - chat works - so the test button must fall back to a
  // raw HTTP probe and report success, not a parse failure.

  const originalFetch = global.fetch;

  beforeEach(() => {
    generateTextMock.mockReset();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    }) as never;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('falls back to raw HTTP probe and reports ok on "Invalid JSON response"', async () => {
    generateTextMock.mockRejectedValue(new Error('Invalid JSON response'));
    const result = await testProviderConnection(anthropicProvider());
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('falls back to raw HTTP probe on a "signature" validation error', async () => {
    generateTextMock.mockRejectedValue(
      new Error('Response signature verification failed: thinking block missing signature'),
    );
    const result = await testProviderConnection(anthropicProvider());
    expect(result.ok).toBe(true);
  });

  it('does NOT fall back for unrelated errors (keeps the real error)', async () => {
    // A 401 is a genuine auth failure - the raw probe would also 401, but we
    // must not mask it as success. Only "Invalid JSON response" / "signature"
    // trigger the bypass.
    generateTextMock.mockRejectedValue(new Error('Unauthorized: invalid api key'));
    // Make the raw probe also fail so we don't accidentally "succeed" via it.
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid api key',
    }) as never;
    const result = await testProviderConnection(anthropicProvider());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('API Key');
  });
});
