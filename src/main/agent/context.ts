import type { CoreMessage } from 'ai';
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { getDb } from '../storage/database.js';
import { sessionsStore } from '../storage/sessions.js';
import { logger } from '../utils/logger.js';
import { microcompactToolResults } from './compaction/microcompact.js';
import { snipCompactIfNeeded } from './compaction/snip.js';

// Context manager — handles message history loading, format conversion,
// and summary compression for the agent loop.
//
// Messages are stored in the DB as { role, content } rows. The AI SDK
// expects CoreMessage[] with role 'user' | 'assistant' | 'system' and
// content as string or structured parts. For the MVP we use simple text
// content — tool call results are embedded as assistant/user text messages.
//
// Compression strategy (v2):
//   When token count exceeds 60% of the model's context window, we use
//   generateText to produce a structured summary of older messages —
//   preserving commands executed, key findings, errors, and decisions.
//   The summary is cached per session so re-compression only processes
//   new messages since the last summary.

// Approximate token estimate: 1 token ≈ 4 chars for English, ≈ 1.5 chars for
// Chinese. We use a conservative 3 chars/token average.
const CHARS_PER_TOKEN = 3;

// Default context window when we can't determine the model's actual size.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 80_000;

// Only trigger summarization when context exceeds 85% of the model window.
// This leaves headroom for the new user message + tool results + response.
// (microcompact/snip still run at 60% for early tool-result truncation)
const COMPRESSION_THRESHOLD_RATIO = 0.85;

// How many recent messages to always keep intact (never summarized).
const RECENT_MESSAGES_TO_KEEP = 20;

// Per-session summary cache. Keyed by sessionId so switching sessions
// doesn't invalidate the other session's summary.
interface ContextSummary {
  summaryText: string;
  summarizedUpTo: number; // index in the message array
  generatedAt: number;
}

// ── DB-backed summary persistence (P0-2.3) ──────────────────────────────────
// Summary is persisted in the sessions table (summary, summary_coverage_index
// columns) so it survives app restarts and session switching.

function saveSummaryToDb(sessionId: string, summary: string, coverageIndex: number): void {
  try {
    const db = getDb();
    db.prepare('UPDATE sessions SET summary = ?, summary_coverage_index = ? WHERE id = ?').run(
      summary,
      coverageIndex,
      sessionId,
    );
  } catch (err) {
    logger.error('[Context] Failed to save summary to DB:', err);
  }
}

function loadSummaryFromDb(sessionId: string): ContextSummary | null {
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT summary, summary_coverage_index FROM sessions WHERE id = ?')
      .get(sessionId) as
      { summary: string | null; summary_coverage_index: number | null } | undefined;
    if (row?.summary) {
      return {
        summaryText: row.summary,
        summarizedUpTo: row.summary_coverage_index ?? 0,
        generatedAt: Date.now(),
      };
    }
  } catch {
    // DB might not have the columns yet (migration not run)
  }
  return null;
}

// In-memory cache for the current session's summary (loaded from DB on first use)
const summaryCache = new Map<string, ContextSummary>();

// ── Model context window lookup ──────────────────────────────────────────

// Static map of known model name patterns → context window size (in tokens).
// Used to replace the old hardcoded 80k threshold with a per-model value.
const MODEL_CONTEXT_WINDOWS: Array<{ pattern: RegExp; tokens: number }> = [
  // Anthropic Claude (all current models share 200k context)
  { pattern: /^claude-/i, tokens: 200_000 },
  // OpenAI GPT-4o / GPT-4 Turbo
  { pattern: /^gpt-4o/i, tokens: 128_000 },
  { pattern: /^gpt-4-turbo/i, tokens: 128_000 },
  { pattern: /^gpt-4\b/i, tokens: 8_192 }, // original GPT-4 8k
  { pattern: /^gpt-3\.5/i, tokens: 16_000 },
  // GLM (Zhipu AI) - glm-4 supports 128k, glm-5.2[1m] supports 1M
  { pattern: /glm.*1m/i, tokens: 1_000_000 },
  { pattern: /^glm-/i, tokens: 128_000 },
  // Qwen - newer models support 128k, older ones 32k
  { pattern: /qwen3/i, tokens: 128_000 },
  { pattern: /qwen2\.5/i, tokens: 128_000 },
  { pattern: /qwen2/i, tokens: 32_000 },
  { pattern: /qwen/i, tokens: 32_000 }, // fallback for older Qwen models
  // DeepSeek
  { pattern: /deepseek/i, tokens: 64_000 },
  // Common local models
  { pattern: /llama-3/i, tokens: 8_000 },
];

export function getModelContextWindow(modelName: string): number {
  for (const entry of MODEL_CONTEXT_WINDOWS) {
    if (entry.pattern.test(modelName)) return entry.tokens;
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

// Get context window with DB-configured override priority.
// Priority: DB context_window > pattern match > default 80k.
export function getContextWindowForModel(
  modelName: string,
  dbContextWindow?: number | null,
): number {
  if (dbContextWindow && dbContextWindow > 0) {
    return dbContextWindow;
  }
  return getModelContextWindow(modelName);
}

// ── Message loading ───────────────────────────────────────────────────────

// Load session messages and convert to AI SDK CoreMessage[].
// Prepends DB-persisted summary if available (P0-2.3).
export function loadMessages(sessionId: string): CoreMessage[] {
  const messages = sessionsStore.listMessages(sessionId);
  const filtered = messages
    .filter((m) => m.role !== 'system') // system prompt is built separately
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  // Prepend persisted summary if available
  const summary = loadSummaryFromDb(sessionId);
  if (summary && summary.summaryText) {
    // Load summary into in-memory cache for compressContext to use
    summaryCache.set(sessionId, summary);
    const summaryMsg: CoreMessage = {
      role: 'system',
      content: `[Context Summary] Previous conversation summary:\n\n${summary.summaryText}`,
    };
    return [summaryMsg, ...filtered];
  }
  return filtered;
}

// Save a user message and assistant response to the DB.
export function saveTurn(sessionId: string, userMessage: string, assistantMessage: string): void {
  sessionsStore.addMessage({
    sessionId,
    role: 'user',
    content: userMessage,
  });
  sessionsStore.addMessage({
    sessionId,
    role: 'assistant',
    content: assistantMessage,
  });
}

export function saveUserMessage(sessionId: string, content: string): void {
  sessionsStore.addMessage({ sessionId, role: 'user', content });
}

export function saveAssistantMessage(sessionId: string, content: string): void {
  sessionsStore.addMessage({ sessionId, role: 'assistant', content });
}

// ── Token estimation ───────────────────────────────────────────────────────

export function estimateTokens(messages: CoreMessage[]): number {
  const totalChars = messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + content.length;
  }, 0);
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

// ── Context compression (model-based summarization) ───────────────────────

// Compress context when it exceeds the model's threshold. Uses generateText
// to produce a structured summary of older messages, preserving diagnostic
// context (commands, findings, errors, decisions) that simple truncation
// would destroy.
//
// The summary is cached per session so re-compression only processes new
// messages since the last summary.
export async function compressContext(
  messages: CoreMessage[],
  opts: { sessionId: string; model: LanguageModel; force?: boolean },
): Promise<CoreMessage[]> {
  const { sessionId, model, force = false } = opts;
  const tokenCount = estimateTokens(messages);

  // Determine the threshold based on the model's context window.
  // model.modelId is the provider-specific model name (e.g., "claude-sonnet-4-6").
  const contextWindow = getModelContextWindow(model.modelId);
  const threshold = Math.floor(contextWindow * COMPRESSION_THRESHOLD_RATIO);

  if (!force && tokenCount <= threshold) {
    return messages;
  }

  logger.info(
    `[Context] Token count ${tokenCount} ${force ? '(forced)' : `exceeds threshold ${threshold}`}, compressing ${messages.length} messages`,
  );

  // Not enough messages to justify summarization — keep as-is.
  if (messages.length <= RECENT_MESSAGES_TO_KEEP + 2) {
    return messages;
  }

  const first = messages[0];
  const recentStart = messages.length - RECENT_MESSAGES_TO_KEEP;
  const toSummarize = messages.slice(1, recentStart);
  const recent = messages.slice(recentStart);

  // Check if we have a cached summary that already covers some of these
  // messages. We only summarize the new (uncached) portion.
  const cached = summaryCache.get(sessionId);
  let summaryText = cached?.summaryText ?? '';

  // Determine which messages need new summarization (those after the cached
  // summary's coverage point). The cache's summarizedUpTo is relative to the
  // full messages array from when the cache was created — we recompute based
  // on message content overlap.
  const newMessagesToSummarize =
    cached && cached.summarizedUpTo > 0
      ? toSummarize.slice(Math.max(0, cached.summarizedUpTo - 1))
      : toSummarize;

  if (newMessagesToSummarize.length > 0) {
    try {
      const newSummary = await generateSummary(newMessagesToSummarize, model, summaryText);
      summaryText = newSummary;
    } catch (err) {
      logger.error('[Context] Summarization failed, falling back to truncation:', err);
      // Fallback: simple truncation (old behavior)
      const fallbackSummary: CoreMessage = {
        role: 'system',
        content: `[上下文压缩] 之前 ${toSummarize.length} 条消息因摘要失败已省略。`,
      };
      return [first, fallbackSummary, ...recent];
    }
  }

  // Update the cache and persist to DB (P0-2.3)
  summaryCache.set(sessionId, {
    summaryText,
    summarizedUpTo: recentStart,
    generatedAt: Date.now(),
  });
  saveSummaryToDb(sessionId, summaryText, recentStart);

  const summaryMessage: CoreMessage = {
    role: 'system',
    content: `[上下文摘要] 以下是之前 ${toSummarize.length} 条消息的结构化总结，供你参考之前的诊断进展：\n\n${summaryText}`,
  };

  return [first, summaryMessage, ...recent];
}

// Generate a structured summary of messages using the model.
// Preserves: commands executed, key findings, errors, decisions.
async function generateSummary(
  messages: CoreMessage[],
  model: LanguageModel,
  previousSummary: string,
): Promise<string> {
  const conversationText = messages
    .map((m) => {
      const role = m.role === 'assistant' ? 'AI' : '用户';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${role}] ${content}`;
    })
    .join('\n\n');

  const prompt = `请对以下运维对话历史生成结构化摘要，保留关键诊断信息。格式如下：

## 执行的命令
- 列出执行的关键命令及其目的（简短）

## 关键发现
- 列出诊断中发现的重要信息（磁盘状态、进程问题、日志错误等）

## 遇到的错误
- 列出执行中遇到的错误和失败原因

## 已做的决策
- 列出已执行的操作和决策（重启了什么服务、修改了什么配置等）

## 当前状态
- 一句话描述当前问题进展

${previousSummary ? `### 之前的摘要（在此基础上增量更新）\n${previousSummary}\n` : ''}
### 待摘要的对话
${conversationText}`;

  const { text } = await generateText({
    model,
    prompt,
    maxTokens: 2000,
  });

  return text.trim();
}

// Build the full message array for the AI SDK call, including the new user message.
// Applies microcompact + snip compaction to keep context manageable (P0-2).
export function buildMessagesForCall(
  history: CoreMessage[],
  newUserMessage: string,
): CoreMessage[] {
  let messages = [...history, { role: 'user' as const, content: newUserMessage }];

  // 1. Microcompact: truncate large tool results (cheapest, runs first)
  const micro = microcompactToolResults(messages);
  if (micro.compactedCount > 0) {
    logger.info(
      `[Context] Microcompact: ${micro.compactedCount} tool results truncated, ~${micro.tokensSaved} tokens saved`,
    );
    messages = micro.messages;
  }

  return messages;
}

// Compact messages in the loop (between streamText calls).
// Applies microcompact + snip if token threshold exceeded.
export function compactMessages(messages: CoreMessage[], contextWindow: number): CoreMessage[] {
  // 1. Microcompact: truncate large tool results
  const micro = microcompactToolResults(messages);
  let result = micro.messages;

  if (micro.compactedCount > 0) {
    logger.info(
      `[Context] Microcompact: ${micro.compactedCount} tool results truncated, ~${micro.tokensSaved} tokens saved`,
    );
  }

  // 2. Snip: remove old tool results if over 40% threshold
  const snip = snipCompactIfNeeded(result, contextWindow);
  if (snip.snipCount > 0) {
    logger.info(
      `[Context] Snip compact: ${snip.snipCount} old tool results snipped, ~${snip.tokensFreed} tokens freed`,
    );
    result = snip.messages;
  }

  return result;
}

// Clear the summary cache for a session (e.g., when session is deleted).
export function clearSummaryCache(sessionId: string): void {
  summaryCache.delete(sessionId);
  // Also clear from DB
  saveSummaryToDb(sessionId, '', 0);
}
