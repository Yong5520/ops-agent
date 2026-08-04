// Tests for the model request retry mechanism (model-retry.ts).
//
// The retry layer owns the full retry policy for model API calls:
//   - classifyModelError: bucket an error into a category (auth/config/endpoint
//     /quota/rate-limit/timeout/transient-network/server-error/unknown)
//   - shouldRetry: is the category worth retrying (up to MAX_RETRIES)?
//   - detectQuotaError: distinguish a HARD quota limit (5h/weekly) from a soft
//     RPM/TPM 429 (the former should surface immediately, the latter retries)
//   - extractApiReason: pull the provider's specific error text out of the
//     APICallError response body / data so the user sees WHY it failed
//   - getRetryDelay: exponential backoff + jitter, respecting retry-after
//   - formatModelFailureMessage: the terminal, user-facing message (named
//     category + API reason)
//   - retryModelRequest: generic retry wrapper (used by ai-command's generateText)

import { describe, it, expect, vi } from 'vitest';
import { APICallError } from 'ai';
import {
  classifyModelError,
  shouldRetry,
  detectQuotaError,
  extractApiReason,
  parseRetryAfter,
  getRetryDelay,
  formatModelFailureMessage,
  retryModelRequest,
  MAX_RETRIES,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
} from '../model-retry.js';

// Helper: build an APICallError with the fields that matter for classification.
function apiError(opts: {
  message: string;
  statusCode?: number;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  data?: unknown;
  isRetryable?: boolean;
}): APICallError {
  return new APICallError({
    message: opts.message,
    url: 'https://model.example.com/v1/chat/completions',
    requestBodyValues: {},
    statusCode: opts.statusCode,
    responseHeaders: opts.responseHeaders,
    responseBody: opts.responseBody,
    isRetryable: opts.isRetryable ?? false,
    data: opts.data,
  });
}

// ── classifyModelError ───────────────────────────────────────────────────

describe('classifyModelError', () => {
  it('classifies 401 Unauthorized as fatal-auth', () => {
    expect(
      classifyModelError(apiError({ message: 'Unauthorized', statusCode: 401 })).category,
    ).toBe('fatal-auth');
  });
  it('classifies 403 Forbidden as fatal-auth', () => {
    expect(classifyModelError(apiError({ message: 'Forbidden', statusCode: 403 })).category).toBe(
      'fatal-auth',
    );
  });
  it('classifies "invalid api key" as fatal-auth', () => {
    expect(classifyModelError(apiError({ message: 'invalid api key' })).category).toBe(
      'fatal-auth',
    );
  });
  it('classifies empty-api-key (OpsAgentError-style message) as fatal-auth', () => {
    expect(classifyModelError(new Error('Active model "X" has an empty API key')).category).toBe(
      'fatal-auth',
    );
  });

  it('classifies "No active model provider" as fatal-config', () => {
    expect(classifyModelError(new Error('No active model provider configured')).category).toBe(
      'fatal-config',
    );
  });
  it('classifies "No model configured" as fatal-config', () => {
    expect(
      classifyModelError(new Error('No model configured. Set a default in Settings.')).category,
    ).toBe('fatal-config');
  });
  it('classifies "model does not exist" as fatal-config', () => {
    expect(classifyModelError(new Error('模型 "foo" 在端点上不存在')).category).toBe(
      'fatal-config',
    );
  });
  it('classifies invalid-action / endpoint path error as fatal-config', () => {
    expect(classifyModelError(new Error('specified action is invalid')).category).toBe(
      'fatal-config',
    );
  });

  it('classifies Connect Timeout as fatal-endpoint (fail fast, no retry)', () => {
    expect(
      classifyModelError(new Error('Cannot connect to API: Connect Timeout Error')).category,
    ).toBe('fatal-endpoint');
  });
  it('classifies ECONNREFUSED as fatal-endpoint', () => {
    expect(classifyModelError(apiError({ message: 'ECONNREFUSED' })).category).toBe(
      'fatal-endpoint',
    );
  });

  it('classifies a hard quota 429 as quota', () => {
    const err = apiError({
      message: '429 Too Many Requests',
      statusCode: 429,
      responseBody:
        '{"error":{"type":"rate_limit_error","message":"You exceeded your current quota"}}',
      data: { error: { type: 'rate_limit_error', message: 'You exceeded your current quota' } },
    });
    expect(classifyModelError(err).category).toBe('quota');
  });
  it('classifies a 5-hour limit 429 as quota', () => {
    const err = apiError({
      message: 'rate_limit_error',
      statusCode: 429,
      responseBody: '{"error":{"message":"You have reached your 5-hour usage limit"}}',
    });
    expect(classifyModelError(err).category).toBe('quota');
  });
  it('classifies a weekly limit 429 (Chinese) as quota', () => {
    const err = apiError({
      message: '429',
      statusCode: 429,
      responseBody: '{"error":{"message":"已达每周用量限额"}}',
    });
    expect(classifyModelError(err).category).toBe('quota');
  });

  it('classifies a soft RPM/TPM 429 as rate-limit (retryable)', () => {
    const err = apiError({
      message: '429 Too Many Requests',
      statusCode: 429,
      responseBody:
        '{"error":{"type":"rate_limit_error","message":"Too many requests per minute"}}',
    });
    expect(classifyModelError(err).category).toBe('rate-limit');
  });
  it('classifies a plain-message 429 (no body) as rate-limit', () => {
    expect(
      classifyModelError(apiError({ message: '429 Too Many Requests', statusCode: 429 })).category,
    ).toBe('rate-limit');
  });

  it('classifies 500/502/503 as server-error', () => {
    expect(classifyModelError(apiError({ message: 'HTTP 500', statusCode: 500 })).category).toBe(
      'server-error',
    );
    expect(classifyModelError(apiError({ message: 'HTTP 502', statusCode: 502 })).category).toBe(
      'server-error',
    );
    expect(classifyModelError(apiError({ message: 'HTTP 503', statusCode: 503 })).category).toBe(
      'server-error',
    );
  });

  it('classifies a timeout as timeout', () => {
    expect(classifyModelError(new Error('The operation was aborted due to timeout')).category).toBe(
      'timeout',
    );
  });
  it('classifies a 408 status as timeout', () => {
    expect(
      classifyModelError(apiError({ message: 'Request Timeout', statusCode: 408 })).category,
    ).toBe('timeout');
  });
  it('classifies ETIMEDOUT as transient-network (not timeout)', () => {
    expect(classifyModelError(new Error('ETIMEDOUT')).category).toBe('transient-network');
  });

  it('classifies ECONNRESET as transient-network', () => {
    expect(classifyModelError(apiError({ message: 'ECONNRESET' })).category).toBe(
      'transient-network',
    );
  });
  it('classifies fetch failed as transient-network', () => {
    expect(classifyModelError(apiError({ message: 'fetch failed' })).category).toBe(
      'transient-network',
    );
  });
  it('classifies "Failed after N attempts" as transient-network', () => {
    expect(
      classifyModelError(new Error('Failed after 3 attempts. Last error: ECONNRESET')).category,
    ).toBe('transient-network');
  });

  it('classifies an unrecognized error as unknown (retryable by default)', () => {
    expect(classifyModelError(new Error('something totally unexpected')).category).toBe('unknown');
  });

  it('populates apiReason from the response body when present', () => {
    const err = apiError({
      message: '429',
      statusCode: 429,
      responseBody: '{"error":{"message":"Too many requests per minute"}}',
      data: { error: { message: 'Too many requests per minute' } },
    });
    expect(classifyModelError(err).apiReason).toBe('Too many requests per minute');
  });
});

// ── shouldRetry ──────────────────────────────────────────────────────────

describe('shouldRetry', () => {
  it('returns true for recoverable categories', () => {
    expect(shouldRetry('rate-limit')).toBe(true);
    expect(shouldRetry('timeout')).toBe(true);
    expect(shouldRetry('transient-network')).toBe(true);
    expect(shouldRetry('server-error')).toBe(true);
    expect(shouldRetry('unknown')).toBe(true);
  });
  it('returns false for fatal categories (no retry)', () => {
    expect(shouldRetry('fatal-auth')).toBe(false);
    expect(shouldRetry('fatal-config')).toBe(false);
    expect(shouldRetry('fatal-endpoint')).toBe(false);
    expect(shouldRetry('quota')).toBe(false);
  });
});

// ── detectQuotaError ─────────────────────────────────────────────────────

describe('detectQuotaError', () => {
  it('detects "insufficient_quota" type', () => {
    expect(
      detectQuotaError(
        apiError({
          message: '429',
          statusCode: 429,
          data: { error: { type: 'insufficient_quota', message: 'out of quota' } },
        }),
      ),
    ).toBe(true);
  });
  it('detects "exceeded your current quota" in body', () => {
    expect(
      detectQuotaError(
        apiError({
          message: '429',
          statusCode: 429,
          responseBody: 'You exceeded your current quota, please check your plan',
        }),
      ),
    ).toBe(true);
  });
  it('detects "5-hour usage limit" signature', () => {
    expect(
      detectQuotaError(
        apiError({ message: '429', statusCode: 429, responseBody: 'reached your 5-hour limit' }),
      ),
    ).toBe(true);
  });
  it('detects weekly limit signature (Chinese "每周")', () => {
    expect(
      detectQuotaError(
        apiError({ message: '429', statusCode: 429, responseBody: '每周限额已达上限' }),
      ),
    ).toBe(true);
  });
  it('detects "余额不足" (insufficient balance)', () => {
    expect(
      detectQuotaError(apiError({ message: '403', statusCode: 403, responseBody: '账户余额不足' })),
    ).toBe(true);
  });

  it('does NOT misfire on a soft RPM rate-limit body', () => {
    expect(
      detectQuotaError(
        apiError({
          message: '429',
          statusCode: 429,
          responseBody:
            '{"error":{"type":"rate_limit_error","message":"Too many requests per minute"}}',
        }),
      ),
    ).toBe(false);
  });
  it('does NOT misfire on a non-429 unrelated error', () => {
    expect(detectQuotaError(new Error('ECONNRESET'))).toBe(false);
  });
});

// ── extractApiReason ─────────────────────────────────────────────────────

describe('extractApiReason', () => {
  it('extracts data.error.message', () => {
    expect(
      extractApiReason(apiError({ message: '429', data: { error: { message: 'rate limited' } } })),
    ).toBe('rate limited');
  });
  it('extracts data.message when no error.message', () => {
    expect(extractApiReason(apiError({ message: 'x', data: { message: 'top-level msg' } }))).toBe(
      'top-level msg',
    );
  });
  it('extracts data.error when it is a string', () => {
    expect(extractApiReason(apiError({ message: 'x', data: { error: 'string error' } }))).toBe(
      'string error',
    );
  });
  it('extracts data.detail', () => {
    expect(extractApiReason(apiError({ message: 'x', data: { detail: 'detail msg' } }))).toBe(
      'detail msg',
    );
  });
  it('parses responseBody JSON when data is absent', () => {
    expect(
      extractApiReason(
        apiError({ message: 'x', responseBody: '{"error":{"message":"from body"}}' }),
      ),
    ).toBe('from body');
  });
  it('returns truncated raw body when not JSON and no structured field', () => {
    const long = 'A'.repeat(500);
    expect(extractApiReason(apiError({ message: 'x', responseBody: long }))).toHaveLength(200);
  });
  it('returns null when no body / data is available', () => {
    expect(extractApiReason(apiError({ message: 'no body' }))).toBeNull();
  });
  it('returns null for a plain (non-APICallError) Error', () => {
    expect(extractApiReason(new Error('plain'))).toBeNull();
  });
  it('sanitizes API keys out of the extracted reason', () => {
    expect(
      extractApiReason(
        apiError({
          message: 'x',
          responseBody: '{"error":{"message":"key sk-abcdefghijklmnopqrstuvwxyz leaked"}}',
        }),
      ),
    ).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });
});

// ── parseRetryAfter ──────────────────────────────────────────────────────

describe('parseRetryAfter', () => {
  it('parses a numeric seconds value', () => {
    expect(parseRetryAfter({ 'retry-after': '5' })).toBe(5000);
  });
  it('parses an HTTP-date value', () => {
    // A date 10s in the future (UTC). Use a fixed offset by constructing from
    // a known base; parseRetryAfter should return ~10s (allow small drift).
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter({ 'retry-after': future });
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(8_000);
    expect(ms!).toBeLessThanOrEqual(10_000);
  });
  it('returns null for a missing header', () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter({})).toBeNull();
  });
  it('returns null for an unparseable value', () => {
    expect(parseRetryAfter({ 'retry-after': 'not-a-date' })).toBeNull();
  });
  it('is case-insensitive on the header name', () => {
    expect(parseRetryAfter({ 'Retry-After': '3' })).toBe(3000);
  });
});

// ── getRetryDelay ────────────────────────────────────────────────────────

describe('getRetryDelay', () => {
  it('grows exponentially with attempt (no jitter)', () => {
    expect(
      getRetryDelay({
        attempt: 0,
        category: 'transient-network',
        err: new Error('x'),
        random: () => 0,
      }),
    ).toBe(BASE_DELAY_MS);
    expect(
      getRetryDelay({
        attempt: 1,
        category: 'transient-network',
        err: new Error('x'),
        random: () => 0,
      }),
    ).toBe(BASE_DELAY_MS * 2);
    expect(
      getRetryDelay({
        attempt: 2,
        category: 'transient-network',
        err: new Error('x'),
        random: () => 0,
      }),
    ).toBe(BASE_DELAY_MS * 4);
    expect(
      getRetryDelay({
        attempt: 3,
        category: 'transient-network',
        err: new Error('x'),
        random: () => 0,
      }),
    ).toBe(BASE_DELAY_MS * 8);
    expect(
      getRetryDelay({
        attempt: 4,
        category: 'transient-network',
        err: new Error('x'),
        random: () => 0,
      }),
    ).toBe(BASE_DELAY_MS * 16);
  });
  it('caps the delay at MAX_DELAY_MS', () => {
    // attempt 10 -> 2^10 * base = 1024s, must cap at MAX_DELAY_MS
    expect(
      getRetryDelay({
        attempt: 10,
        category: 'server-error',
        err: new Error('x'),
        random: () => 0,
      }),
    ).toBe(MAX_DELAY_MS);
  });
  it('jitter stays within [base, base*1.25]', () => {
    const base = BASE_DELAY_MS; // attempt 0
    const lo = getRetryDelay({
      attempt: 0,
      category: 'unknown',
      err: new Error('x'),
      random: () => 0,
    });
    const hi = getRetryDelay({
      attempt: 0,
      category: 'unknown',
      err: new Error('x'),
      random: () => 1,
    });
    expect(lo).toBe(base);
    expect(hi).toBe(Math.round(base * 1.25));
  });
  it('respects retry-after for rate-limit (>= retry-after)', () => {
    const err = apiError({
      message: '429',
      statusCode: 429,
      responseHeaders: { 'retry-after': '5' },
    });
    const delay = getRetryDelay({ attempt: 0, category: 'rate-limit', err, random: () => 0 });
    expect(delay).toBeGreaterThanOrEqual(5000);
  });
  it('caps retry-after at MAX_DELAY_MS', () => {
    const err = apiError({
      message: '429',
      statusCode: 429,
      responseHeaders: { 'retry-after': '120' },
    });
    const delay = getRetryDelay({ attempt: 0, category: 'rate-limit', err, random: () => 0 });
    expect(delay).toBeLessThanOrEqual(MAX_DELAY_MS);
  });
  it('does not apply retry-after for non-rate-limit categories', () => {
    const err = apiError({
      message: '500',
      statusCode: 500,
      responseHeaders: { 'retry-after': '30' },
    });
    // server-error with retry-after 30s should still use exponential (1s at attempt 0),
    // NOT the 30s retry-after.
    const delay = getRetryDelay({ attempt: 0, category: 'server-error', err, random: () => 0 });
    expect(delay).toBe(BASE_DELAY_MS);
  });
});

// ── formatModelFailureMessage ────────────────────────────────────────────

describe('formatModelFailureMessage', () => {
  it('names a quota failure clearly and appends the API reason', () => {
    const err = apiError({
      message: '429',
      statusCode: 429,
      responseBody: '{"error":{"message":"exceeded your current quota"}}',
      data: { error: { message: 'exceeded your current quota' } },
    });
    const msg = formatModelFailureMessage(err);
    expect(msg).toMatch(/限额/);
    expect(msg).toContain('exceeded your current quota');
  });
  it('names a rate-limit failure (mentions retry count)', () => {
    const msg = formatModelFailureMessage(apiError({ message: '429', statusCode: 429 }));
    expect(msg).toMatch(/限速/);
    expect(msg).toMatch(/5/);
  });
  it('names a timeout failure', () => {
    const msg = formatModelFailureMessage(new Error('The operation was aborted due to timeout'));
    expect(msg).toMatch(/超时/);
  });
  it('names a transient-network failure', () => {
    const msg = formatModelFailureMessage(apiError({ message: 'ECONNRESET' }));
    expect(msg).toMatch(/网络|连接/);
  });
  it('names a server-error failure', () => {
    const msg = formatModelFailureMessage(apiError({ message: 'HTTP 500', statusCode: 500 }));
    expect(msg).toMatch(/5xx|服务端/);
  });
  it('names an auth failure and points at Settings', () => {
    const msg = formatModelFailureMessage(apiError({ message: 'Unauthorized', statusCode: 401 }));
    expect(msg).toMatch(/API Key|鉴权|授权/);
    expect(msg).toMatch(/设置/);
  });
  it('names an endpoint-unreachable failure as fail-fast', () => {
    const msg = formatModelFailureMessage(
      new Error('Cannot connect to API: Connect Timeout Error'),
    );
    expect(msg).toMatch(/无法连接|端点|不可达/);
  });
  it('prefixes every category with the 模型异常 tag', () => {
    const cases = [
      apiError({ message: 'Unauthorized', statusCode: 401 }),
      apiError({ message: '429', statusCode: 429 }),
      new Error('Cannot connect to API: Connect Timeout Error'),
      apiError({ message: 'ECONNRESET' }),
      apiError({ message: 'HTTP 500', statusCode: 500 }),
      new Error('The operation was aborted due to timeout'),
    ];
    for (const err of cases) {
      expect(formatModelFailureMessage(err)).toContain('模型异常');
    }
  });
});

// ── retryModelRequest ────────────────────────────────────────────────────

describe('retryModelRequest', () => {
  // Inject a no-op sleep so tests never wait on real timers.
  const noSleep = async () => {};
  const noDelay = () => 0;

  it('returns the result on first success (no retries)', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryModelRequest({ fn, sleep: noSleep, getDelay: noDelay });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a recoverable error until success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError({ message: '429', statusCode: 429 }))
      .mockRejectedValueOnce(apiError({ message: 'ECONNRESET' }))
      .mockResolvedValueOnce('recovered');
    const onRetry = vi.fn();
    const result = await retryModelRequest({
      fn,
      sleep: noSleep,
      getDelay: noDelay,
      onRetry,
    });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries and throws a terminal message naming the category', async () => {
    const fn = vi.fn().mockRejectedValue(apiError({ message: 'ECONNRESET' }));
    await expect(retryModelRequest({ fn, sleep: noSleep, getDelay: noDelay })).rejects.toThrow(
      /网络|连接/,
    );
    // 1 initial + MAX_RETRIES retries
    expect(fn).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });

  it('does NOT retry a fatal-auth error (fails immediately)', async () => {
    const fn = vi.fn().mockRejectedValue(apiError({ message: 'Unauthorized', statusCode: 401 }));
    await expect(retryModelRequest({ fn, sleep: noSleep, getDelay: noDelay })).rejects.toThrow(
      /API Key|鉴权|授权/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a hard-quota error (fails immediately)', async () => {
    const fn = vi.fn().mockRejectedValue(
      apiError({
        message: '429',
        statusCode: 429,
        responseBody: 'exceeded your current quota',
      }),
    );
    await expect(retryModelRequest({ fn, sleep: noSleep, getDelay: noDelay })).rejects.toThrow(
      /限额/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a fatal-endpoint error (fails immediately)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Cannot connect to API: Connect Timeout Error'));
    await expect(retryModelRequest({ fn, sleep: noSleep, getDelay: noDelay })).rejects.toThrow(
      /无法连接|端点|不可达/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry after an abort (throws, no further attempts)', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(apiError({ message: '429', statusCode: 429 }));
    controller.abort();
    await expect(
      retryModelRequest({ fn, abortSignal: controller.signal, sleep: noSleep, getDelay: noDelay }),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects a custom maxRetries override', async () => {
    const fn = vi.fn().mockRejectedValue(apiError({ message: '429', statusCode: 429 }));
    await expect(
      retryModelRequest({ fn, maxRetries: 2, sleep: noSleep, getDelay: noDelay }),
    ).rejects.toThrow();
    // 1 initial + 2 retries
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('passes the computed delay + attempt to onRetry', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError({ message: '429', statusCode: 429 }))
      .mockResolvedValueOnce('ok');
    const onRetry = vi.fn();
    const getDelay = () => 1234;
    await retryModelRequest({ fn, sleep: noSleep, getDelay, onRetry });
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), 1234);
  });

  it('honors a shouldRetryError override (e.g. fail fast on a deterministic error)', async () => {
    // Simulate ai-command's SDK parse-error exclusion: a normally-retryable
    // 'unknown' error is forced non-retryable, so it fails on the first call.
    const fn = vi.fn().mockRejectedValue(new Error('Invalid JSON response from model'));
    const shouldRetryError = (err: Error) => !/Invalid JSON response|signature/i.test(err.message);
    await expect(
      retryModelRequest({ fn, sleep: noSleep, getDelay: noDelay, shouldRetryError }),
    ).rejects.toThrow(/模型异常/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
