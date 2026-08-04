// Model request retry policy + failure classification.
//
// This module owns the full retry strategy for model API calls, decoupled from
// I/O so every decision is unit-testable. The agent loop (streamText) and the
// terminal command generator (generateText) both build on these primitives:
//
//   - classifyModelError: bucket an error into a category
//   - shouldRetry:        is the category worth retrying (up to MAX_RETRIES)?
//   - detectQuotaError:   distinguish a HARD quota limit (5h/weekly) from a
//                         soft RPM/TPM 429. Hard quota surfaces immediately
//                         (retrying a hours-long block is pointless); soft 429
//                         retries with backoff.
//   - extractApiReason:   pull the provider's specific error text out of the
//                         APICallError response body / data so the user sees
//                         WHY it failed, not just our generic phrasing.
//   - parseRetryAfter:    parse the Retry-After header (seconds or HTTP-date).
//   - getRetryDelay:      exponential backoff + jitter, respecting Retry-After.
//   - formatModelFailureMessage: the terminal, user-facing message (named
//                         category + API reason).
//   - retryModelRequest:  generic retry wrapper (used by ai-command's
//                         generateText; the streaming loop reuses the
//                         primitives directly).
//
// Design notes:
//   - Callers set `maxRetries: 0` on streamText/generateText so the AI SDK
//     surfaces the RAW APICallError on the first failure (with statusCode /
//     responseBody / data). With the SDK's default maxRetries=2 the error is
//     wrapped as "Failed after N attempts" and the structured fields are lost,
//     which would make classification + API-reason extraction unreliable.
//   - Retries are only taken when no substantive text has streamed yet in the
//     current round (enforced by the loop, not here) to avoid duplicate text.

import { APICallError } from 'ai';
import {
  formatModelError,
  isTransientNetworkError,
  isUnreachableEndpoint,
} from './model-errors.js';

// ── Tunable policy constants ──────────────────────────────────────────────
// 5 retries after the initial attempt (6 total). Exponential backoff from 1s,
// capped at 30s, so the worst-case retry wait stays bounded (~1+2+4+8+16s).
export const MAX_RETRIES = 5;
export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 30_000;
// Jitter fraction (0..0.25 of the exponential delay) to avoid thundering-herd
// retries against a rate-limited endpoint.
const JITTER_FRACTION = 0.25;

export type ModelErrorCategory =
  | 'fatal-auth' // 401/403/invalid key/empty key -> never retry
  | 'fatal-config' // no provider / bad model name / bad endpoint path -> never retry
  | 'fatal-endpoint' // Connect Timeout / ECONNREFUSED -> dead host, fail fast
  | 'quota' // hard 5h/weekly quota -> surface immediately, do not retry
  | 'rate-limit' // soft RPM/TPM 429 -> retry with backoff (respect Retry-After)
  | 'timeout' // request timed out -> retry
  | 'transient-network' // ECONNRESET/ETIMEDOUT/EPIPE/fetch failed -> retry
  | 'server-error' // 500/502/503 -> retry
  | 'unknown'; // unrecognized -> retry conservatively

export interface ClassifiedError {
  category: ModelErrorCategory;
  apiReason: string | null;
}

// Strong signatures that mark a 4xx/429 as a HARD usage quota (5-hour / weekly
// / billing) rather than a soft per-minute rate limit. A hard quota will not
// recover within a retry cycle, so we surface it immediately. Conservative by
// design: a soft RPM/TPM body ("Too many requests per minute",
// "rate_limit_error" without a usage-limit message) must NOT match.
const QUOTA_SIGNATURES: readonly RegExp[] = [
  /insufficient_quota/i,
  /exceeded your current quota/i,
  /insufficient balance/i,
  /余额不足/,
  /配额/,
  /额度/,
  /5[\s-]*hour|five[\s-]*hour/i,
  /weekly|每周/,
  /5小时/,
  /usage[\s_-]*limit/i,
];

// Auth failure signatures (invalid key / forbidden / empty key).
const AUTH_SIGNATURES: readonly RegExp[] = [
  /unauthorized/i,
  /invalid api key/i,
  /forbidden/i,
  /empty api key/i,
];

// Config failure signatures (no provider, bad model name, bad endpoint path).
const CONFIG_SIGNATURES: readonly RegExp[] = [
  /no active model provider/i,
  /no model configured/i,
  /不存在/,
  /可用模型/,
  /specified action is invalid/i,
  /invalid action/i,
];

// ── detectQuotaError ──────────────────────────────────────────────────────
// True only when a strong hard-quota signature appears in the response body or
// parsed error data. Scans both responseBody (raw) and data (JSON-stringified)
// so it works whether the provider's errorSchema matched (data populated) or
// not (only responseBody available).
export function detectQuotaError(err: Error): boolean {
  const text = quotaSearchText(err);
  if (!text) return false;
  return QUOTA_SIGNATURES.some((re) => re.test(text));
}

function quotaSearchText(err: Error): string {
  if (APICallError.isInstance(err)) {
    const parts: string[] = [];
    if (err.responseBody) parts.push(err.responseBody);
    if (err.data != null) {
      parts.push(typeof err.data === 'string' ? err.data : safeStringify(err.data));
    }
    return parts.join('\n');
  }
  return err.message ?? '';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

// ── extractApiReason ──────────────────────────────────────────────────────
// Pull the most informative human-readable reason out of an APICallError's
// response body / data. Tries common error-envelope shapes across providers
// (Anthropic, OpenAI, OpenAI-compatible): data.error.message, data.message,
// data.error (string), data.detail; falls back to JSON.parse(responseBody),
// then to a truncated raw body. Returns null when nothing is available.
// Sanitizes accidental API-key / Bearer-token leakage.
export function extractApiReason(err: Error): string | null {
  if (!APICallError.isInstance(err)) return null;

  const fromData = extractFromData(err.data);
  if (fromData) return sanitize(fromData);

  if (err.responseBody) {
    const parsed = tryParseJson(err.responseBody);
    if (parsed != null) {
      const fromParsed = extractFromData(parsed);
      if (fromParsed) return sanitize(fromParsed);
    }
    const trimmed = err.responseBody.trim();
    if (trimmed) return sanitize(trimmed.slice(0, 200));
  }
  return null;
}

// Extract a reason string from a parsed error object using common envelope
// shapes. `data` may itself be a string (some providers return a plain string).
function extractFromData(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === 'string') return data.trim() || null;
  if (typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const errorField = obj.error;
  if (errorField != null && typeof errorField === 'object') {
    const errMsg = (errorField as Record<string, unknown>).message;
    if (typeof errMsg === 'string' && errMsg.trim()) return errMsg.trim();
  }
  if (typeof errorField === 'string' && errorField.trim()) return errorField.trim();
  if (typeof obj.message === 'string' && obj.message.trim()) return obj.message.trim();
  if (typeof obj.detail === 'string' && obj.detail.trim()) return obj.detail.trim();
  return null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Redact accidental credential leakage from a reason string before showing it
// to the user. Matches sk-style keys and Bearer tokens.
const SECRET_PATTERNS: readonly RegExp[] = [/sk-[A-Za-z0-9]{10,}/g, /Bearer\s+[A-Za-z0-9._-]+/gi];
function sanitize(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

// ── parseRetryAfter ───────────────────────────────────────────────────────
// Parse a Retry-After header into milliseconds. Supports both the
// delta-seconds form ("5") and the HTTP-date form. Returns null when the
// header is missing or unparseable. Case-insensitive header lookup.
export function parseRetryAfter(headers?: Record<string, string>): number | null {
  if (!headers) return null;
  const value = getHeader(headers, 'retry-after');
  if (!value) return null;
  const trimmed = value.trim();
  // Delta-seconds form.
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  // HTTP-date form.
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, parsed - Date.now());
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

// ── classifyModelError ────────────────────────────────────────────────────
// Bucket an error into a category. Priority is deliberate:
//   1. quota        - a hard usage limit surfaces immediately (never retry).
//   2. fatal-auth   - 401/403/invalid key (never retry).
//   3. fatal-config - no provider / bad model name / bad endpoint (never retry).
//   4. fatal-endpoint - Connect Timeout / ECONNREFUSED: dead host, fail fast.
//   5. rate-limit   - soft 429 (retry).
//   6. server-error - 5xx (retry).
//   7. timeout      - 408 / TimeoutError / "timeout" in message (retry).
//   8. transient-network - ECONNRESET/ETIMEDOUT/EPIPE/fetch failed (retry).
//   9. unknown      - unrecognized (retry conservatively).
// Quota is checked before auth because some providers return 403 + a
// "余额不足" body for billing exhaustion, which is a quota issue, not an auth
// issue.
export function classifyModelError(err: Error): ClassifiedError {
  const msg = err.message ?? '';
  const statusCode = APICallError.isInstance(err) ? err.statusCode : undefined;
  const apiReason = extractApiReason(err);

  if (detectQuotaError(err)) {
    return { category: 'quota', apiReason };
  }
  if (statusCode === 401 || statusCode === 403 || AUTH_SIGNATURES.some((re) => re.test(msg))) {
    return { category: 'fatal-auth', apiReason };
  }
  if (CONFIG_SIGNATURES.some((re) => re.test(msg))) {
    return { category: 'fatal-config', apiReason };
  }
  if (isUnreachableEndpoint(err)) {
    return { category: 'fatal-endpoint', apiReason };
  }
  if (statusCode === 429 || /\brate.?limit\b/i.test(msg) || /\b429\b/.test(msg)) {
    return { category: 'rate-limit', apiReason };
  }
  if (statusCode === 500 || statusCode === 502 || statusCode === 503 || /\b50[023]\b/.test(msg)) {
    return { category: 'server-error', apiReason };
  }
  if (statusCode === 408 || err.name === 'TimeoutError' || /timeout/i.test(msg)) {
    return { category: 'timeout', apiReason };
  }
  if (isTransientNetworkError(err)) {
    return { category: 'transient-network', apiReason };
  }
  return { category: 'unknown', apiReason };
}

// ── shouldRetry ───────────────────────────────────────────────────────────
export function shouldRetry(category: ModelErrorCategory): boolean {
  switch (category) {
    case 'rate-limit':
    case 'timeout':
    case 'transient-network':
    case 'server-error':
    case 'unknown':
      return true;
    case 'fatal-auth':
    case 'fatal-config':
    case 'fatal-endpoint':
    case 'quota':
      return false;
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

// ── getRetryDelay ─────────────────────────────────────────────────────────
// Exponential backoff (base * 2^attempt) capped at MAX_DELAY_MS, plus up to
// JITTER_FRACTION jitter. For rate-limit, the delay is at least the server's
// Retry-After value (also capped at MAX_DELAY_MS so a hostile retry-after
// can't stall the loop). `random` is injectable for deterministic tests.
export function getRetryDelay(opts: {
  attempt: number;
  category: ModelErrorCategory;
  err: Error;
  random?: () => number;
}): number {
  const random = opts.random ?? Math.random;
  const expDelay = Math.min(BASE_DELAY_MS * 2 ** opts.attempt, MAX_DELAY_MS);
  const jitter = random() * expDelay * JITTER_FRACTION;
  let delay = expDelay + jitter;
  if (opts.category === 'rate-limit' && APICallError.isInstance(opts.err)) {
    const retryAfterMs = parseRetryAfter(opts.err.responseHeaders);
    if (retryAfterMs != null) {
      delay = Math.max(delay, retryAfterMs);
    }
  }
  return Math.min(Math.round(delay), MAX_DELAY_MS);
}

// ── formatModelFailureMessage ─────────────────────────────────────────────
// The terminal, user-facing message shown after retries are exhausted (or for
// a non-retryable failure). Names the failure category clearly (限额 / 限速 /
// 超时 / 网络 / 5xx / 鉴权 / 端点) and appends the API's own reason when we
// extracted one. Every variant carries the 模型异常 tag so the user can tell
// a model-side failure apart from an SSH/tool execution failure (执行异常).
export function formatModelFailureMessage(err: Error): string {
  const { category, apiReason } = classifyModelError(err);
  const base = baseFailureMessage(category, err);
  if (apiReason) {
    return `${base}\n（API 返回原因：${apiReason}）`;
  }
  return base;
}

function baseFailureMessage(category: ModelErrorCategory, err: Error): string {
  switch (category) {
    case 'quota':
      return '⚠️ 模型异常：模型已达用量限额（如 5 小时/每周限额）。请稍后再试，或在设置页更换模型/提升配额。';
    case 'rate-limit':
      return '⚠️ 模型异常：模型请求被限速（已重试 5 次仍被限）。请稍后重试或降低请求频率。';
    case 'timeout':
      return '⚠️ 模型异常：模型请求超时（已重试 5 次）。请检查网络或模型端点响应速度。';
    case 'transient-network':
      return '⚠️ 模型异常：与模型端点的网络连接不稳定（已重试 5 次）。请检查网络与端点可达性，可在设置页点击“测试连接”。';
    case 'server-error':
      return '⚠️ 模型异常：模型服务端错误（5xx，已重试 5 次）。请稍后重试。';
    case 'fatal-auth':
      return `⚠️ 模型异常：${formatModelError(err)}`;
    case 'fatal-config':
      return `⚠️ 模型异常：${formatModelError(err)}`;
    case 'fatal-endpoint':
      return `⚠️ 模型异常：${formatModelError(err)} 端点不可达，已跳过重试。`;
    case 'unknown':
      return `⚠️ 模型异常：${(err.message ?? '').slice(0, 300)}`;
    default: {
      const exhaustive: never = category;
      return `⚠️ 模型异常：${exhaustive}`;
    }
  }
}

// ── retryModelRequest ─────────────────────────────────────────────────────
// Generic retry wrapper for a non-streaming model call (ai-command's
// generateText). Retries recoverable categories up to maxRetries (default 5),
// rethrows aborts immediately, and throws a terminal formatModelFailureMessage
// for non-retryable errors or exhausted retries. `sleep` and `getDelay` are
// injectable so tests never wait on real timers.
export interface RetryModelRequestOptions<T> {
  fn: () => Promise<T>;
  maxRetries?: number;
  abortSignal?: AbortSignal;
  onRetry?: (attempt: number, err: Error, delayMs: number) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  getDelay?: (opts: { attempt: number; category: ModelErrorCategory; err: Error }) => number;
  // Override the retry decision for a specific error. When provided, this
  // replaces the default shouldRetry(classifyModelError(err).category) check.
  // ai-command uses it to fail fast on deterministic SDK parse errors (which
  // route to a raw-HTTP fallback instead of retrying).
  shouldRetryError?: (err: Error) => boolean;
}

export async function retryModelRequest<T>(opts: RetryModelRequestOptions<T>): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  const getDelay = opts.getDelay ?? getRetryDelay;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await opts.fn();
    } catch (err) {
      const error = err as Error;
      // User abort (before or during the call): rethrow immediately, no retry.
      if (opts.abortSignal?.aborted || error.name === 'AbortError') {
        throw error;
      }
      const { category } = classifyModelError(error);
      const retryable = opts.shouldRetryError
        ? opts.shouldRetryError(error)
        : shouldRetry(category);
      if (!retryable || attempt >= maxRetries) {
        throw new Error(formatModelFailureMessage(error));
      }
      const delayMs = getDelay({ attempt, category, err: error });
      opts.onRetry?.(attempt + 1, error, delayMs);
      attempt++;
      // If the wait is aborted, defaultSleep rejects with an AbortError which
      // propagates out of the catch block (it is not re-caught here) and the
      // caller treats it as a cancellation.
      await sleep(delayMs, opts.abortSignal);
    }
  }
}

// Default sleep: resolves after ms, but rejects with an AbortError if the
// signal fires mid-wait (so an abort during backoff is responsive, not stuck
// waiting for the full delay). Cleans up its abort listener on resolve.
async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeAbortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}
