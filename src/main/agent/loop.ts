import { streamText } from 'ai';
import { getActiveModel, validateModelExists } from './providers.js';
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
import { modelsStore } from '../storage/models.js';
import { gatherMultipleHostFacts } from './facts.js';
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

    // ── 2. Build system prompt (with runtime host facts) ──────────────────
    // Gather facts for each selected host in parallel — this gives the AI
    // immediate context (OS, kernel, failed services, disk usage) so it can
    // skip the basic info-gathering tool calls and start diagnosing.
    const hostInfos = hostIds
      .map((id) => hostsStore.get(id))
      .filter((h): h is NonNullable<typeof h> => h !== null)
      .map((h) => ({ id: h.id, name: h.name }));
    const hostFacts = await gatherMultipleHostFacts(hostInfos);

    const system = buildSystemPrompt({
      selectedHostIds: hostIds,
      safetyMode,
      hostFacts,
    });

    // ── 3. Get active model (needed before context compression) ───────────
    // Pre-flight: validate that the model name exists on the endpoint.
    // Some proxies (New API) reset the TCP connection (ECONNRESET) instead
    // of returning a clean HTTP error when the model name is invalid.
    const activeProvider = modelsStore.getActive();
    if (activeProvider) {
      logger.info(
        `[Agent] Pre-flight check: model="${activeProvider.modelName}" type=${activeProvider.type} endpoint=${activeProvider.endpoint}`,
      );
      await validateModelExists(activeProvider);
    }
    const model = getActiveModel();

    // ── 4. Load + compress message history ─────────────────────────────────
    const history = await compressContext(loadMessages(sessionId), { sessionId, model });
    let messages = buildMessagesForCall(history, userMessage);

    // Save user message immediately (assistant message saved after streaming)
    saveUserMessage(sessionId, userMessage);

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

    // ── 6. Stream text (with conclusion-nudge loop) ───────────────────────
    // Some models (e.g. glm-5.2) call tools then emit a short transitional
    // phrase ("让我继续检查X") and finish with reason 'stop' — never
    // producing a substantive conclusion. When we detect this stall pattern
    // (tool calls happened + short text + transitional words), we nudge the
    // model with an explicit "give your analysis" message and run another
    // round. Capped at MAX_NUDGE_ROUNDS to prevent infinite loops.
    // Empirically validated against session d6372529 (2026-07-07).
    const MAX_NUDGE_ROUNDS = 2;
    const STALL_TRANSITION_PATTERN = /让我|我来|继续|我先|接下来|下一步/;
    const STALL_TEXT_THRESHOLD = 150;
    let nudgeCount = 0;
    let toolCallCount = 0;
    let lastFinishReason = '';
    let fullText = '';
    let stalled = true;

    while (stalled) {
      toolCallCount = 0;
      lastFinishReason = '';
      let roundText = '';

      const result = streamText({
        model,
        system,
        messages,
        tools,
        maxSteps,
        maxTokens: 8192,
        abortSignal,
      });

      for await (const part of result.fullStream) {
        // Check for cancellation between stream chunks. The abortSignal also
        // propagates into the SDK, but this gives us a clean exit point.
        if (abortSignal?.aborted) {
          logger.info(
            `[Agent] Loop aborted by user; preserving ${fullText.length + roundText.length} chars of partial text`,
          );
          break;
        }
        switch (part.type) {
          case 'text-delta': {
            const delta = part.textDelta;
            roundText += delta;
            params.onTextStream(delta);
            break;
          }

          case 'tool-call': {
            toolCallCount++;
            break;
          }

          case 'error': {
            const err = part.error as Error;
            // AbortError arrives here when the signal fires mid-stream — treat
            // it as a clean cancellation, not an error.
            if (err.name === 'AbortError' || abortSignal?.aborted) {
              logger.info(
                `[Agent] Stream aborted; preserving partial text (${roundText.length} chars)`,
              );
              break;
            }
            logger.error(`[Agent] Stream error: ${err.message}`);
            // If we got no text at all, surface via onError.
            if (!roundText && !fullText) {
              throw err;
            }
            // Partial text exists: inline the error so the user sees the
            // response was truncated, instead of silently completing.
            roundText += `\n\n---\n⚠️ 响应中断: ${err.message}`;
            break;
          }

          case 'finish': {
            const reason = part.finishReason;
            lastFinishReason = reason;
            logger.info(
              `[Agent] Loop finished: reason=${reason}, tokens=${part.usage?.totalTokens ?? 'unknown'}`,
            );
            if (reason === 'length') {
              roundText += `\n\n---\n⚠️ Agent 达到输出长度限制，响应被截断。`;
            } else if (reason === 'tool-calls') {
              roundText += `\n\n---\n⚠️ Agent 达到最大步数限制 (${maxSteps})，仍有未完成的操作。可继续提问以延续。`;
            } else if (reason === 'content-filter') {
              roundText += `\n\n---\n⚠️ 响应被内容过滤器截断。`;
            }
            break;
          }

          default:
            // tool-result, tool-input-start, etc. are handled inside each
            // tool's execute function via onToolCall/onToolResult callbacks.
            break;
        }
      }

      fullText += roundText;

      // Detect "inconclusive stop": model called tools but stopped without a
      // substantive conclusion. Two stall patterns:
      //  (a) short transitional phrase ("让我继续检查X") — text < threshold AND
      //      matches transition words
      //  (b) zero text after tool calls — model called tools, produced no
      //      assistant text, and stopped (user sees only tool cards, no analysis)
      const isTransitionStall =
        roundText.length > 0 &&
        roundText.length < STALL_TEXT_THRESHOLD &&
        STALL_TRANSITION_PATTERN.test(roundText);
      const isEmptyStall = roundText.length === 0;
      stalled =
        lastFinishReason === 'stop' &&
        toolCallCount > 0 &&
        (isTransitionStall || isEmptyStall) &&
        nudgeCount < MAX_NUDGE_ROUNDS &&
        !abortSignal?.aborted;

      if (stalled) {
        nudgeCount++;
        logger.info(
          `[Agent] Detected inconclusive stop (toolCalls=${toolCallCount}, text=${roundText.length} chars); nudging for conclusion, round ${nudgeCount}/${MAX_NUDGE_ROUNDS}`,
        );

        // CRITICAL: Use result.response.messages (not roundText) so the next
        // round sees the full assistant message INCLUDING tool calls and tool
        // results. Appending only roundText would strip tool context — the
        // nudge message "基于以上已执行的命令结果" would reference results
        // the model cannot see, risking hallucination or redundant re-runs.
        // ResponseMessage[] = [CoreAssistantMessage (with tool calls), CoreToolMessage (with results)]
        const response = await result.response;
        messages = [
          ...messages,
          ...response.messages,
          {
            role: 'user' as const,
            content:
              '请基于以上已执行的命令结果，给出你的实质性分析结论。如果诊断信息已足够，请总结发现和结论；如果还需更多信息，请继续执行命令。不要只输出"让我继续检查"之类的声明。',
          },
        ];
        // Visual separator in the streamed UI output between rounds.
        fullText += '\n\n';
        params.onTextStream('\n\n');
      }
    }

    // ── 7. Save assistant message ──────────────────────────────────────────
    if (fullText) {
      saveAssistantMessage(sessionId, fullText);
    }

    // ── 8. Complete ────────────────────────────────────────────────────────
    logger.info(`[Agent] Loop complete: ${fullText.length} chars output (nudges=${nudgeCount})`);
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
  if (
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('fetch failed') ||
    msg.includes('Cannot connect to API')
  ) {
    return '无法连接模型 API 端点。这通常是由于端点 URL 不正确（需以 /v1 结尾）、模型名称不存在、或网络不通导致。请在设置页检查模型配置并点击"测试连接"。';
  }
  if (msg.includes('No active model provider')) {
    return '未配置活跃模型供应商。请先在设置页配置模型。';
  }
  return msg;
}
