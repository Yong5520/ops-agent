// AI command generation for the terminal page.
//
// Users type natural language (e.g., "统计下当前目录的大小") and the AI
// generates a corresponding Linux command + explanation + safety level.
// The user then approves/modifies/rejects before execution.
//
// This module provides:
//   - parseCommandResponse: robust JSON extraction from AI text output
//   - generateCommand: calls the active AI model via generateText
//     with raw HTTP fallback for providers that return non-standard
//     response shapes (e.g., glm-5.2 thinking blocks without signatures)

import { generateText, type LanguageModel } from 'ai';
import { getActiveModel } from './providers.js';
import { modelsStore } from '../storage/models.js';
import { getCachedHostFacts, refreshHostFactsInBackground } from './facts.js';
import { hostsStore } from '../storage/hosts.js';
import { logger } from '../utils/logger.js';
import { retryModelRequest, classifyModelError, shouldRetry } from './model-retry.js';

export interface GeneratedCommand {
  command: string;
  explanation: string;
  safetyLevel: 'read' | 'write' | 'sudo';
}

export interface GenerateCommandParams {
  naturalLanguage: string;
  hostId?: string;
}

// ── In-memory result cache ─────────────────────────────────────────────────
// Repeat or near-repeat intents return instantly without hitting the model.
// Keyed by normalized input + OS so the same words on different OSes can
// yield different commands. Short TTL + size cap keep it from going stale
// or growing unbounded.
const COMMAND_CACHE_TTL_MS = 5 * 60 * 1000;
const COMMAND_CACHE_MAX = 50;

interface CachedCommand {
  result: GeneratedCommand;
  cachedAt: number;
}

const commandCache = new Map<string, CachedCommand>();

function commandCacheKey(naturalLanguage: string, osInfo?: string): string {
  return `${osInfo ?? 'any'}::${naturalLanguage.trim().toLowerCase()}`;
}

function getCachedCommand(key: string): GeneratedCommand | null {
  const entry = commandCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > COMMAND_CACHE_TTL_MS) {
    commandCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCachedCommand(key: string, result: GeneratedCommand): void {
  commandCache.set(key, { result, cachedAt: Date.now() });
  // Map preserves insertion order - evict the oldest entry past the cap.
  while (commandCache.size > COMMAND_CACHE_MAX) {
    const oldestKey = commandCache.keys().next().value;
    if (oldestKey === undefined) break;
    commandCache.delete(oldestKey);
  }
}

/** Clear the result cache. Exposed for tests. */
export function clearCommandCache(): void {
  commandCache.clear();
}

/**
 * Parse the AI's text response into a GeneratedCommand.
 *
 * The AI may wrap JSON in markdown code blocks or surround it with
 * conversational text. We extract the first valid JSON object and
 * parse its fields. If parsing fails, fall back to using the raw text
 * as the command (conservative: treat as write-level for safety).
 */
export function parseCommandResponse(raw: string): GeneratedCommand {
  if (!raw || raw.trim().length === 0) {
    return { command: '', explanation: '', safetyLevel: 'write' };
  }

  // Try to extract a JSON object from the response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const command = typeof parsed.command === 'string' ? parsed.command.trim() : '';
      const explanation = typeof parsed.explanation === 'string' ? parsed.explanation.trim() : '';
      const rawSafety =
        typeof parsed.safetyLevel === 'string' ? parsed.safetyLevel.toLowerCase() : '';
      const safetyLevel = normalizeSafetyLevel(rawSafety);
      return { command, explanation, safetyLevel };
    } catch {
      // JSON parse failed - fall through to raw text fallback
    }
  }

  // Fallback: treat raw text as the command itself
  return {
    command: raw.trim(),
    explanation: '',
    safetyLevel: 'write',
  };
}

function normalizeSafetyLevel(raw: string): 'read' | 'write' | 'sudo' {
  if (raw === 'read' || raw === 'write' || raw === 'sudo') return raw;
  return 'write'; // conservative default for unknown levels
}

/**
 * Build the system prompt for command generation.
 * Includes host facts (OS, kernel) if available for context-aware commands.
 */
function buildSystemPrompt(osInfo?: string, kernelInfo?: string): string {
  const hostContext = osInfo
    ? `\n## 目标主机信息\n- 操作系统: ${osInfo}\n- 内核: ${kernelInfo ?? 'unknown'}\n`
    : '';

  return `你是一个 Linux 运维助手。用户用自然语言描述操作意图，你生成对应的 Linux 命令。
${hostContext}
## 规则
1. 只生成一条命令（可用管道 | 或 && 组合多条）
2. 命令必须安全、正确、可直接在 bash 中执行
3. 返回严格的 JSON 格式，不要包含 markdown 代码块标记：
   {"command":"具体命令","explanation":"中文解释每个参数的作用","safetyLevel":"read|write|sudo"}
4. safetyLevel 判定标准：
   - read: 只读操作（ls, cat, ps, df, free, du, top, grep 等）
   - write: 修改文件或系统状态（rm, cp, mv, mkdir, touch, systemctl restart 等）
   - sudo: 需要 root 权限执行的命令
5. 禁止生成 rm -rf /、mkfs、dd if=/dev/zero 等破坏性命令
6. 如果用户意图不明确，生成最接近的命令并在 explanation 中说明假设

## 示例
用户输入: "统计当前目录大小"
输出: {"command":"du -sh .","explanation":"du 统计磁盘使用，-s 汇总不显示子目录，-h 人类可读格式(GB/MB)","safetyLevel":"read"}

用户输入: "重启 nginx 服务"
输出: {"command":"sudo systemctl restart nginx","explanation":"systemctl restart 重启服务，sudo 获取 root 权限","safetyLevel":"sudo"}`;
}

/**
 * Raw HTTP fallback for providers where the Anthropic SDK's strict
 * response validation fails (e.g., glm-5.2 returns thinking blocks
 * without the `signature` field that @ai-sdk/anthropic requires).
 *
 * Makes a direct POST to the provider's Anthropic-compatible /messages
 * endpoint and extracts text content manually.
 */
async function rawAnthropicGenerate(
  provider: { apiKey: string; endpoint?: string; modelName: string },
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
): Promise<string> {
  const baseURL = (provider.endpoint || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  const url = `${baseURL}/messages`;

  const body = {
    model: provider.modelName,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI request failed (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  // Extract text from content blocks, skip thinking blocks
  const textBlocks = (data.content || []).filter((b) => b.type === 'text' && b.text);
  return textBlocks.map((b) => b.text!).join('');
}

// Matches a complete JSON object in the model output. Used to detect
// truncation: a response with no closing brace is not a complete object and
// must not be used as-is.
const JSON_OBJECT_PATTERN = /\{[\s\S]*\}/;

/**
 * Call the active model for command generation, encapsulating the raw-HTTP
 * fallback for providers whose thinking blocks fail SDK validation
 * (e.g. glm-5.2 returns thinking blocks without the `signature` field).
 *
 * Retries recoverable failures (transient network / timeout / soft 429 / 5xx)
 * up to MAX_RETRIES (5) via retryModelRequest, then surfaces a categorized,
 * user-facing message (限速/超时/网络/5xx/限额/鉴权 + the API's own reason).
 * SDK parse errors are NOT retried - they fall through to the raw-HTTP fallback.
 */
async function generateCommandText(
  model: LanguageModel,
  systemPrompt: string,
  naturalLanguage: string,
  maxTokens: number,
): Promise<string> {
  try {
    const result = await retryModelRequest({
      fn: () =>
        generateText({
          model,
          system: systemPrompt,
          prompt: naturalLanguage,
          maxTokens,
          // 0 = let retryModelRequest own all retries; this also makes the SDK
          // surface the raw APICallError (statusCode/responseBody) on the
          // first failure so classification + API-reason extraction are
          // reliable (with the default maxRetries=2 the SDK wraps it as
          // "Failed after N attempts" and the structured fields are lost).
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(20_000),
        }),
      // SDK parse errors (glm-5.2 thinking blocks without signature) are
      // deterministic - retrying won't help. Fail fast so the catch below can
      // route to the raw-HTTP fallback.
      shouldRetryError: (err) => {
        const msg = err.message || '';
        if (/Invalid JSON response|signature/i.test(msg)) return false;
        return shouldRetry(classifyModelError(err).category);
      },
      onRetry: (attempt, err, delayMs) =>
        logger.warn(
          `[AI Command] retry ${attempt} after ${delayMs}ms: ${err.message.slice(0, 120)}`,
        ),
    });
    return result.text;
  } catch (err) {
    const errMsg = (err as Error).message || '';
    // SDK parse error -> raw HTTP fallback (bypasses SDK validation).
    // retryModelRequest throws a formatModelFailureMessage whose 'unknown'
    // text carries the original parse-error string, so we detect it here and
    // recover via the raw path instead of surfacing the error.
    if (errMsg.includes('Invalid JSON response') || errMsg.includes('signature')) {
      logger.warn(`[AI Command] SDK failed (${errMsg.slice(0, 120)}), falling back to raw HTTP`);
      const provider = modelsStore.getActive();
      if (!provider || !provider.apiKey) {
        throw new Error('No active model provider with API key configured');
      }
      return rawAnthropicGenerate(
        { apiKey: provider.apiKey, endpoint: provider.endpoint, modelName: provider.modelName },
        systemPrompt,
        naturalLanguage,
        maxTokens,
      );
    }
    // Otherwise the error is already a categorized formatModelFailureMessage
    // (限速/超时/网络/5xx/限额/鉴权 + API reason) from retryModelRequest.
    throw err;
  }
}

/**
 * Generate a Linux command from natural language input.
 * Uses the active AI model provider.
 *
 * Strategy:
 * 1. Try the Vercel AI SDK's generateText (preferred - handles streaming, retries, etc.)
 * 2. If that fails with a type validation error (e.g., glm-5.2 thinking blocks
 *    without signatures), fall back to raw HTTP call that bypasses SDK validation
 */
export async function generateCommand(params: GenerateCommandParams): Promise<GeneratedCommand> {
  const { naturalLanguage, hostId } = params;

  let osInfo: string | undefined;
  let kernelInfo: string | undefined;

  // Use cached facts only - NEVER block on an SSH round-trip for command
  // generation (it added 0.5-3s of latency on a cold cache). If the cache is
  // cold, kick off a background refresh so the NEXT call has OS context, but
  // proceed immediately without it. OS info is a nice-to-have, not essential
  // for generating a correct command.
  if (hostId) {
    const host = hostsStore.get(hostId);
    if (host) {
      const facts = getCachedHostFacts(hostId);
      if (facts) {
        osInfo = facts.os;
        kernelInfo = facts.kernel;
      } else {
        refreshHostFactsInBackground(hostId, host.name);
      }
    }
  }

  // Cache hit? Return the previously generated command instantly.
  const cacheKey = commandCacheKey(naturalLanguage, osInfo);
  const cached = getCachedCommand(cacheKey);
  if (cached) {
    logger.info(`[AI Command] Cache hit for: "${naturalLanguage.slice(0, 80)}"`);
    return cached;
  }

  const systemPrompt = buildSystemPrompt(osInfo, kernelInfo);
  const model = getActiveModel();

  logger.info(
    `[AI Command] Generating command for: "${naturalLanguage.slice(0, 80)}"${hostId ? ` (host: ${hostId})` : ''}`,
  );

  // glm-5.2 emits thinking blocks that count against maxTokens. 1024 fits
  // thinking + the short JSON in the common case (and maxTokens is a cap, not
  // a target, so it does not slow down the normal response). If the output
  // still looks truncated (no complete JSON object), retry once with a larger
  // budget rather than returning a broken command.
  let text = await generateCommandText(model, systemPrompt, naturalLanguage, 1024);
  let jsonMatched = JSON_OBJECT_PATTERN.test(text);
  if (!jsonMatched && text.trim()) {
    logger.warn(
      '[AI Command] Response looked truncated (no complete JSON), retrying with larger budget',
    );
    text = await generateCommandText(model, systemPrompt, naturalLanguage, 2048);
    jsonMatched = JSON_OBJECT_PATTERN.test(text);
  }

  const parsed = parseCommandResponse(text);
  // Only cache cleanly JSON-parsed results - never cache a truncated fallback,
  // which would poison the cache with a wrong command.
  if (parsed.command && jsonMatched) {
    setCachedCommand(cacheKey, parsed);
  }
  return parsed;
}
