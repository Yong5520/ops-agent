import { describe, it, expect } from 'vitest';
import { APICallError } from 'ai';
import {
  formatModelError,
  formatExecutionErrorMessage,
  isModelError,
  isTransientNetworkError,
  isUnreachableEndpoint,
} from '../model-errors.js';
import { OpsAgentError } from '../../ssh/connection.js';

describe('formatModelError', () => {
  it('returns the raw message unchanged when no pattern matches', () => {
    const msg = formatModelError(new Error('something totally unexpected'));
    expect(msg).toBe('something totally unexpected');
  });

  it('detects 401 Unauthorized', () => {
    const msg = formatModelError(new Error('Unauthorized: invalid api key'));
    expect(msg).toContain('API Key');
    expect(msg).toContain('设置页');
  });

  it('detects 429 rate limit without matching hex/ids that contain "429"', () => {
    // Regression: "02178412064429246d1ea" contains "429" but must NOT match
    const msg = formatModelError(new Error('request id 02178412064429246d1ea failed'));
    expect(msg).toBe('request id 02178412064429246d1ea failed');
  });

  it('detects 429 rate limit', () => {
    const msg = formatModelError(new Error('429 Too Many Requests'));
    expect(msg).toContain('频率');
  });

  it('detects invalid action / endpoint path error', () => {
    const msg = formatModelError(new Error('specified action is invalid'));
    expect(msg).toContain('端点');
  });

  it('detects 500/502/503 server errors via word boundary', () => {
    expect(formatModelError(new Error('HTTP 500'))).toContain('服务端错误');
    expect(formatModelError(new Error('HTTP 502'))).toContain('服务端错误');
    expect(formatModelError(new Error('HTTP 503'))).toContain('服务端错误');
  });

  it('does not false-match "503" inside a longer id', () => {
    // Regression guard: hex like "a503f2" must not match 503
    const msg = formatModelError(new Error('trace a503f2c failed'));
    expect(msg).toBe('trace a503f2c failed');
  });

  it('detects connection errors (ECONNRESET, fetch failed, etc.)', () => {
    expect(formatModelError(new Error('fetch failed'))).toContain('无法连接');
    expect(formatModelError(new Error('ECONNRESET'))).toContain('无法连接');
    expect(formatModelError(new Error('Cannot connect to API'))).toContain('无法连接');
  });

  it('detects missing model provider', () => {
    const msg = formatModelError(new Error('No active model provider configured'));
    expect(msg).toContain('模型');
  });

  it('classifies "No model configured" (resolveModelProvider: no override + no default)', () => {
    // Thrown by resolveModelProvider when a session has no override AND there
    // is no global active default. Must surface as a model error (not an
    // execution error) with an actionable Settings/selector nudge.
    expect(isModelError(new Error('No model configured. Set a default in Settings.'))).toBe(true);
    const msg = formatModelError(new Error('No model configured'));
    expect(msg).toContain('设置页');
    expect(msg).toContain('选择一个模型');
  });
});

describe('isTransientNetworkError', () => {
  it('returns true for ECONNRESET', () => {
    expect(isTransientNetworkError(new Error('ECONNRESET'))).toBe(true);
  });
  it('returns true for ETIMEDOUT', () => {
    expect(isTransientNetworkError(new Error('ETIMEDOUT'))).toBe(true);
  });
  it('returns true for EPIPE', () => {
    expect(isTransientNetworkError(new Error('EPIPE broken pipe'))).toBe(true);
  });
  it('returns true for ECONNREFUSED', () => {
    expect(isTransientNetworkError(new Error('ECONNREFUSED'))).toBe(true);
  });
  it('returns true for fetch failed', () => {
    expect(isTransientNetworkError(new Error('fetch failed'))).toBe(true);
  });
  it('returns true for socket hang up', () => {
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true);
  });
  it('returns true for Failed after N attempts', () => {
    expect(isTransientNetworkError(new Error('Failed after 3 attempts'))).toBe(true);
  });
  it('returns false for a 401 auth error', () => {
    expect(isTransientNetworkError(new Error('Unauthorized'))).toBe(false);
  });
  it('returns false for an unrelated error', () => {
    expect(isTransientNetworkError(new Error('some parse error'))).toBe(false);
  });
});

describe('isUnreachableEndpoint', () => {
  // Fix B: connect-timeout errors mean the host/port is unreachable. Retrying
  // for ~2 minutes is pointless - we should fail fast instead.
  it('returns true for Connect Timeout Error', () => {
    expect(isUnreachableEndpoint(new Error('Cannot connect to API: Connect Timeout Error'))).toBe(
      true,
    );
  });
  it('returns true for "Failed after N attempts" with connect timeout', () => {
    expect(
      isUnreachableEndpoint(
        new Error(
          'Failed after 3 attempts. Last error: Cannot connect to API: Connect Timeout Error',
        ),
      ),
    ).toBe(true);
  });
  it('returns true for ECONNREFUSED (connection refused = nothing listening)', () => {
    expect(isUnreachableEndpoint(new Error('ECONNREFUSED'))).toBe(true);
  });
  it('returns false for ECONNRESET (transient - host IS reachable, connection dropped mid-stream)', () => {
    expect(isUnreachableEndpoint(new Error('ECONNRESET'))).toBe(false);
  });
  it('returns false for ETIMEDOUT (transient - could be slow response, host may be reachable)', () => {
    expect(isUnreachableEndpoint(new Error('ETIMEDOUT'))).toBe(false);
  });
  it('returns false for a 429 rate limit', () => {
    expect(isUnreachableEndpoint(new Error('429 rate limit'))).toBe(false);
  });
  it('returns false for an unrelated error', () => {
    expect(isUnreachableEndpoint(new Error('parse error'))).toBe(false);
  });
});

describe('isModelError', () => {
  // The purpose of isModelError: distinguish errors that originate from the
  // MODEL API (auth, rate-limit, 5xx, bad endpoint, connection to the model
  // host, missing provider) from errors that originate elsewhere (SSH, tools,
  // local parse failures). When true, the UI should frame the failure as
  // "model异常" and point the user at Settings -> Test connection.

  it('returns true for 401 / Unauthorized', () => {
    expect(isModelError(new Error('Unauthorized: invalid api key'))).toBe(true);
  });
  it('returns true for 429 rate limit', () => {
    expect(isModelError(new Error('429 Too Many Requests'))).toBe(true);
  });
  it('returns true for 5xx server errors', () => {
    expect(isModelError(new Error('HTTP 500'))).toBe(true);
    expect(isModelError(new Error('HTTP 502 Bad Gateway'))).toBe(true);
    expect(isModelError(new Error('HTTP 503'))).toBe(true);
  });
  it('returns true for invalid action / endpoint path error', () => {
    expect(isModelError(new Error('specified action is invalid'))).toBe(true);
  });
  it('returns true for connection errors (fetch failed, ECONNRESET, ECONNREFUSED)', () => {
    expect(isModelError(new Error('fetch failed'))).toBe(true);
    expect(isModelError(new Error('ECONNRESET'))).toBe(true);
    expect(isModelError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isModelError(new Error('Cannot connect to API'))).toBe(true);
  });
  it('returns true for "No active model provider" missing-provider error', () => {
    expect(isModelError(new Error('No active model provider configured'))).toBe(true);
  });
  it('returns true for empty-api-key provider errors (OpsAgentError from providers)', () => {
    expect(isModelError(new Error('Active model "X" has an empty API key'))).toBe(true);
  });
  it('returns true for "model does not exist on endpoint" validation error', () => {
    expect(isModelError(new Error('模型 "foo" 在端点上不存在'))).toBe(true);
  });
  it('returns true for an APICallError with a statusCode even without a signature message', () => {
    // A 429 whose message is just "Too Many Requests" (no "429" digit, no
    // "rate limit") must still be recognized as a model error via the
    // APICallError statusCode, so the loop frames it as 模型异常.
    const err = new APICallError({
      message: 'Too Many Requests',
      url: 'https://example.com',
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: true,
    });
    expect(isModelError(err)).toBe(true);
  });

  it('does NOT false-match 429 inside a hex id', () => {
    expect(isModelError(new Error('request id 02178412064429246d1ea failed'))).toBe(false);
  });
  it('does NOT false-match 503 inside a hex id', () => {
    expect(isModelError(new Error('trace a503f2c failed'))).toBe(false);
  });

  it('returns false for a generic SSH error', () => {
    // SSH errors must NOT be classified as model errors - they come from the
    // host tool execution, not the model API.
    expect(isModelError(new Error('All configured authentication methods failed'))).toBe(false);
  });
  it('returns false for an OpsAgentError SSH_AUTH code', () => {
    const err = new OpsAgentError('SSH authentication failed', 'SSH_AUTH');
    expect(isModelError(err)).toBe(false);
  });
  it('returns false for a totally unrelated parse error', () => {
    expect(isModelError(new Error('Unexpected token in JSON'))).toBe(false);
  });
});

describe('formatExecutionErrorMessage', () => {
  it('prefixes model errors with the "模型异常" tag', () => {
    const msg = formatExecutionErrorMessage(new Error('fetch failed'));
    expect(msg).toContain('模型异常');
    // Must still carry the friendly detail from formatModelError.
    expect(msg).toContain('无法连接');
  });
  it('prefixes a 401 with the "模型异常" tag and friendly detail', () => {
    const msg = formatExecutionErrorMessage(new Error('Unauthorized: invalid api key'));
    expect(msg).toContain('模型异常');
    expect(msg).toContain('API Key');
  });
  it('points model errors toward Settings -> Test connection', () => {
    const msg = formatExecutionErrorMessage(new Error('429 Too Many Requests'));
    expect(msg).toMatch(/设置|测试|模型配置/);
  });
  it('prefixes non-model errors with the "执行异常" tag (NOT "模型异常")', () => {
    const msg = formatExecutionErrorMessage(
      new Error('All configured authentication methods failed'),
    );
    expect(msg).toContain('执行异常');
    expect(msg).not.toContain('模型异常');
    // Still surfaces the original message so the user can debug.
    expect(msg).toContain('All configured authentication methods failed');
  });
  it('prefixes an unrelated local error with "执行异常" and the raw message', () => {
    const msg = formatExecutionErrorMessage(new Error('Unexpected token in JSON'));
    expect(msg).toContain('执行异常');
    expect(msg).toContain('Unexpected token in JSON');
  });
});
