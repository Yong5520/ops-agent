// Model API error classification and formatting.
//
// Extracted from loop.ts so the heuristics are unit-testable. Five questions:
//   - formatModelError: what user-facing message describes this error?
//   - isModelError: did this error originate from the MODEL API (vs SSH/tools/local)?
//   - formatExecutionErrorMessage: tagged message for the loop's failure paths
//     ("模型异常" vs "执行异常") so the user knows WHERE the problem is.
//   - isTransientNetworkError: is it worth auto-retrying (brief backoff)?
//   - isUnreachableEndpoint: is the host/port dead (skip retries, fail fast)?

const HTTP_401_PATTERN = /\b401\b/;
const HTTP_429_PATTERN = /\b429\b/;
// 500/502/503 (NOT 504, which is a gateway timeout - usually transient).
const HTTP_50X_PATTERN = /\b50[023]\b/;

// Connect-timeout / refused signatures. The host is not accepting the TCP
// connection at all - distinct from mid-stream drops (ECONNRESET/ETIMEDOUT)
// where the host was reachable but the connection died.
const CONNECT_TIMEOUT_PATTERN = /Connect Timeout Error/i;
const UNREACHABLE_PATTERNS = [CONNECT_TIMEOUT_PATTERN, /\bECONNREFUSED\b/];

// Signatures that mark an error as originating from the MODEL API rather than
// from SSH/tool execution or local code. These MUST stay aligned with the
// branches in formatModelError (below) and the errors thrown by providers.ts
// (validateModelExists, getActiveModel) so classification is consistent.
const MODEL_ERROR_SIGNATURES = [
  'Unauthorized',
  'invalid api key',
  'rate limit',
  'Rate limit',
  'specified action is invalid',
  'invalid action',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'fetch failed',
  'Cannot connect to API',
  'socket hang up',
  'No active model provider',
  'No model configured', // resolveModelProvider: no override + no global default
  'empty API key',
  '不存在', // "model ... does not exist on endpoint" (validateModelExists)
  '可用模型',
];

export function formatModelError(err: Error): string {
  const msg = err.message;
  if (
    msg.includes('Unauthorized') ||
    msg.includes('invalid api key') ||
    HTTP_401_PATTERN.test(msg)
  ) {
    return '模型 API Key 无效或已过期。请在设置页检查模型配置。';
  }
  if (msg.includes('rate limit') || msg.includes('Rate limit') || HTTP_429_PATTERN.test(msg)) {
    return '模型 API 请求频率超限。请稍后重试或检查 API 配额。';
  }
  if (msg.includes('specified action is invalid') || msg.includes('invalid action')) {
    return '模型 API 端点路径错误。请检查端点 URL 是否正确。OpenAI 兼容模型应使用 /api/v3 结尾（不包含 /responses）。';
  }
  if (HTTP_50X_PATTERN.test(msg)) {
    return '模型服务端错误。请稍后重试。';
  }
  if (
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('fetch failed') ||
    msg.includes('Cannot connect to API')
  ) {
    return '无法连接模型 API 端点。这通常是由于端点 URL 不正确、模型名称不存在、或网络不通导致。请在设置页检查模型配置并点击“测试连接”。';
  }
  if (msg.includes('No active model provider')) {
    return '未配置活跃模型供应商。请先在设置页配置模型。';
  }
  if (msg.includes('No model configured')) {
    // resolveModelProvider: the session has no override AND no global default.
    return '未配置模型。请在设置页配置默认模型，或在会话标题栏为本会话选择一个模型。';
  }
  return msg;
}

// Did this error originate from the MODEL API (auth, rate-limit, 5xx, bad
// endpoint, connection to the model host, missing provider) vs from elsewhere
// (SSH, tool execution, local parse failures)? When true the UI frames the
// failure as a "模型异常" and points the user at Settings -> Test connection.
//
// Conservative by design: an error is a model error only if its message
// matches a known model-API signature (or an HTTP 4xx/429/5xx code). SSH auth
// failures, command timeouts, and tool errors do NOT match and are correctly
// treated as non-model (execution) errors.
export function isModelError(err: Error): boolean {
  const msg = err.message ?? '';
  if (HTTP_401_PATTERN.test(msg)) return true;
  if (HTTP_429_PATTERN.test(msg)) return true;
  if (HTTP_50X_PATTERN.test(msg)) return true;
  return MODEL_ERROR_SIGNATURES.some((sig) => msg.includes(sig));
}

// Tagged, user-facing message for the agent loop's failure paths. Every
// failure surfaces with a clear category label so the user understands WHERE
// the problem is, instead of a raw error string:
//   - Model API errors   -> "⚠️ 模型异常：<formatModelError detail>"
//   - Everything else      -> "⚠️ 执行异常：<raw message>"
// Model errors additionally nudge the user toward Settings -> Test connection
// when the friendly detail does not already mention it.
export function formatExecutionErrorMessage(err: Error): string {
  if (isModelError(err)) {
    const detail = formatModelError(err);
    const nudge = /设置|测试连接|模型配置/.test(detail) ? '' : ' 请前往设置页点击“测试连接”排查。';
    return `⚠️ 模型异常：${detail}${nudge}`;
  }
  return `⚠️ 执行异常：${err.message}`;
}

// Check if an error is a transient network error worth auto-retrying.
// ECONNRESET, ETIMEDOUT, EPIPE, etc. are typically temporary and benefit
// from a short delay + retry, especially with local/self-hosted models.
export function isTransientNetworkError(err: Error): boolean {
  const msg = err.message;
  if (msg.includes('ECONNRESET')) return true;
  if (msg.includes('ETIMEDOUT')) return true;
  if (msg.includes('EPIPE')) return true;
  if (msg.includes('ECONNREFUSED')) return true;
  if (msg.includes('fetch failed')) return true;
  if (msg.includes('socket hang up')) return true;
  if (msg.includes('network')) return true;
  if (msg.includes('Failed after') && msg.includes('attempts')) return true;
  return false;
}

// Check if the error indicates the endpoint is DEAD (host unreachable or
// nothing listening). Such errors should skip the retry cycle and fail fast -
// retrying a dead host for ~2 minutes wastes the user's time.
//
// Connect Timeout Error: TCP connect() never completed (host down / firewalled).
// ECONNREFUSED: TCP RST on connect (nothing listening on the port).
//
// NOT transient: ECONNRESET (host was reachable, connection dropped mid-stream)
// and ETIMEDOUT (host reachable, response too slow) - these can recover.
export function isUnreachableEndpoint(err: Error): boolean {
  const msg = err.message;
  return UNREACHABLE_PATTERNS.some((p) => p.test(msg));
}
