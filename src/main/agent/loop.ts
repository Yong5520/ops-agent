import { streamText } from 'ai';
import { getActiveModel } from './providers.js';
import { createTools } from './tools.js';
import { buildSystemPrompt } from './system-prompt.js';
import {
  loadMessages,
  compressContext,
  buildMessagesForCall,
  saveUserMessage,
  saveAssistantMessage,
} from './context.js';
import { hostsStore } from '../storage/hosts.js';
import { logger } from '../utils/logger.js';
import type { AgentLoopParams, SessionContext } from './types.js';

// Agent main loop — the core of the application.
//
// Flow:
//   1. Build system prompt from session context
//   2. Load + compress session message history
//   3. Get active language model
//   4. Create tools (closured over session context + callbacks)
//   5. streamText with maxSteps for multi-turn tool calling
//   6. Stream text deltas to UI
//   7. Save user + assistant messages to DB
//   8. Call onComplete with final text
//
// Security and authorization are handled inside each tool's execute function
// (see tools.ts). The loop itself is agnostic to safety mode.

export async function runAgentLoop(params: AgentLoopParams): Promise<void> {
  const { sessionId, userMessage, hostIds, safetyMode, maxSteps = 20, abortSignal } = params;

  try {
    // ── 1. Resolve session context ─────────────────────────────────────────
    // Resolve the first selected host as the default. The full allow list is
    // enforced by resolveHost in tools.ts.
    const defaultHost = hostIds[0] ? (hostsStore.get(hostIds[0]) ?? undefined) : undefined;
    const context: SessionContext = {
      sessionId,
      hostIds,
      hostName: defaultHost?.name ?? '__default__',
      hostIp: defaultHost?.host ?? 'unknown',
      safetyMode,
      defaultHost,
    };

    // ── 2. Build system prompt ─────────────────────────────────────────────
    const system = buildSystemPrompt({
      selectedHostIds: hostIds,
      safetyMode,
    });

    // ── 3. Load + compress message history ─────────────────────────────────
    const history = compressContext(loadMessages(sessionId));
    const messages = buildMessagesForCall(history, userMessage);

    // Save user message immediately (assistant message saved after streaming)
    saveUserMessage(sessionId, userMessage);

    // ── 4. Get active model ────────────────────────────────────────────────
    const model = getActiveModel();

    // ── 5. Create tools ────────────────────────────────────────────────────
    const tools = createTools({
      context,
      safetyMode,
      onToolCall: params.onToolCall,
      onToolResult: params.onToolResult,
      onAuthorizationRequired: params.onAuthorizationRequired,
    });

    logger.info(
      `[Agent] Starting loop: session=${sessionId}, hosts=${hostIds.length}, mode=${safetyMode}, messages=${messages.length}`,
    );

    // ── 6. Stream text ─────────────────────────────────────────────────────
    const result = streamText({
      model,
      system,
      messages,
      tools,
      maxSteps,
      abortSignal,
    });

    let fullText = '';

    for await (const part of result.fullStream) {
      // Check for cancellation between stream chunks. The abortSignal also
      // propagates into the SDK, but this gives us a clean exit point.
      if (abortSignal?.aborted) {
        logger.info(
          `[Agent] Loop aborted by user; preserving ${fullText.length} chars of partial text`,
        );
        break;
      }
      switch (part.type) {
        case 'text-delta': {
          const delta = part.textDelta;
          fullText += delta;
          params.onTextStream(delta);
          break;
        }

        case 'error': {
          const err = part.error as Error;
          // AbortError arrives here when the signal fires mid-stream — treat
          // it as a clean cancellation, not an error.
          if (err.name === 'AbortError' || abortSignal?.aborted) {
            logger.info(
              `[Agent] Stream aborted; preserving partial text (${fullText.length} chars)`,
            );
            break;
          }
          logger.error(`[Agent] Stream error: ${err.message}`);
          // If we got no text at all, the error happened before any output —
          // surface it to the user via onError instead of completing silently.
          if (!fullText) {
            throw err;
          }
          // If we have partial text, let the loop complete with what we have.
          break;
        }

        case 'finish': {
          logger.info(`[Agent] Loop finished: ${part.usage?.totalTokens ?? 'unknown'} tokens`);
          break;
        }

        default:
          // tool-call, tool-result, tool-input-start, etc. are handled inside
          // each tool's execute function via onToolCall/onToolResult callbacks.
          // We intentionally don't double-notify here.
          break;
      }
    }

    // ── 7. Save assistant message ──────────────────────────────────────────
    if (fullText) {
      saveAssistantMessage(sessionId, fullText);
    }

    // ── 8. Complete ────────────────────────────────────────────────────────
    logger.info(`[Agent] Loop complete: ${fullText.length} chars output`);
    params.onComplete(fullText);
  } catch (err) {
    const error = err as Error;
    // AbortError surfacing from streamText — treat as clean cancellation.
    if (error.name === 'AbortError' || abortSignal?.aborted) {
      logger.info(`[Agent] Loop aborted via AbortError; partial text preserved by caller`);
      return;
    }
    logger.error(`[Agent] Loop failed: ${error.message}`, error);
    const friendly = formatModelError(error);
    // Include the original error so the user can diagnose the real issue
    params.onError(new Error(`${friendly}\n\n详细信息: ${error.message}`));
  }
}

// Format model API errors into user-friendly messages.
function formatModelError(err: Error): string {
  const msg = err.message;
  if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('invalid api key')) {
    return '模型 API Key 无效或已过期。请在设置页检查模型配置。';
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Rate limit')) {
    return '模型 API 请求频率超限。请稍后重试或检查 API 配额。';
  }
  if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
    return '模型服务端错误。请稍后重试。';
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    return '无法连接模型 API 端点。请检查网络和端点配置。';
  }
  if (msg.includes('No active model provider')) {
    return '未配置活跃模型供应商。请先在设置页配置模型。';
  }
  return msg;
}
