// Tests for rawProbeConnection: the SDK-bypass fallback used by the
// "测试连接" button when generateText fails on a "Invalid JSON response"
// (e.g. glm-5.2 thinking blocks missing the `signature` field the SDK requires).
//
// Strategy: send a minimal HTTP request straight to the provider's chat
// endpoint and look ONLY at the HTTP status code. A 200 means the endpoint is
// reachable, the API key is valid, and the model name is accepted - i.e. the
// connection is healthy even though the SDK can't parse the (non-standard)
// response body. A non-200 is surfaced with its status code so formatModelError
// can classify it (401 -> invalid key, etc.).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Silence logger.
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { rawProbeConnection } from '../providers.js';
import type { ModelProvider } from '../../../shared/types.js';

function anthropic(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: 'p1',
    name: 'Test',
    type: 'anthropic',
    endpoint: '',
    apiKey: 'sk-ant-test',
    modelName: 'claude-sonnet-4-6',
    isActive: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function openaiCompatible(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    ...anthropic(),
    type: 'openai-compatible',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'ark-test',
    modelName: 'glm-5.2',
    ...overrides,
  };
}

function mockFetchOk() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
}

function mockFetchStatus(status: number, body = '') {
  return vi.fn().mockResolvedValue({ ok: false, status, text: async () => body });
}

describe('rawProbeConnection', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = mockFetchOk() as never;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POSTs to /messages with the Anthropic header set on success', async () => {
    const fetchMock = mockFetchOk();
    global.fetch = fetchMock as never;
    await rawProbeConnection(anthropic());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/messages');
    const headers = init.headers as Record<string, string>;
    // Anthropic uses x-api-key, not Bearer.
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('resolves (does not throw) on a 200 response', async () => {
    global.fetch = mockFetchOk() as never;
    await expect(rawProbeConnection(anthropic())).resolves.toBeUndefined();
  });

  it('throws with the HTTP status code on a 401', async () => {
    global.fetch = mockFetchStatus(401, 'invalid api key') as never;
    await expect(rawProbeConnection(anthropic())).rejects.toThrow(/401/);
  });

  it('throws with the HTTP status code on a 5xx', async () => {
    global.fetch = mockFetchStatus(503, 'service unavailable') as never;
    await expect(rawProbeConnection(anthropic())).rejects.toThrow(/503/);
  });

  it('POSTs to /chat/completions with a Bearer token for openai-compatible', async () => {
    const fetchMock = mockFetchOk();
    global.fetch = fetchMock as never;
    await rawProbeConnection(openaiCompatible());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer ark-test');
  });

  it('resolves on a 200 for openai-compatible (the SDK-bypass case)', async () => {
    // This is the whole point: a model whose JSON the SDK rejects with
    // "Invalid JSON response" still returns HTTP 200, so the connection is
    // healthy and the probe should succeed.
    global.fetch = mockFetchOk() as never;
    await expect(rawProbeConnection(openaiCompatible())).resolves.toBeUndefined();
  });

  it('propagates a network error (fetch rejects)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed: ECONNREFUSED')) as never;
    await expect(rawProbeConnection(anthropic())).rejects.toThrow('fetch failed');
  });
});
