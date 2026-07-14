import { streamText } from 'ai';
import type { CoreSystemMessage, CoreMessage } from 'ai';
import { getActiveModel, validateModelExists } from './providers.js';
import { createTools } from './tools.js';
import { buildSystemPrompt } from './system-prompt.js';
import {
  loadMessages,
  compressContext,
  buildMessagesForCall,
  saveUserMessage,
  saveAssistantMessage,
  getContextWindowForModel,
  compactMessages,
  estimateTokens,
} from './context.js';
import { createBudgetTracker, updateBudget, checkTokenBudget } from './token-budget.js';
import {
  createDenialTracker,
  recordDenial,
  recordApproval,
  shouldNudgeAfterDenials,
} from './denial-tracking.js';
import type { ModeHolder } from './tools/exit-plan-mode.js';
import { hostsStore } from '../storage/hosts.js';
import { modelsStore } from '../storage/models.js';
import { gatherMultipleHostFacts } from './facts.js';
import { logger } from '../utils/logger.js';
import type { AgentLoopParams, SessionContext, ToolCallResult } from './types.js';

// Agent main loop - the core of the application.
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
  const { sessionId, userMessage, hostIds, safetyMode, maxSteps = 50, abortSignal } = params;

  // Declare outside try so the catch block can access it for saving partial work
  let fullText = '';

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
    // Gather facts for each selected host in parallel - this gives the AI
    // immediate context (OS, kernel, failed services, disk usage) so it can
    // skip the basic info-gathering tool calls and start diagnosing.
    const hostInfos = hostIds
      .map((id) => hostsStore.get(id))
      .filter((h): h is NonNullable<typeof h> => h !== null)
      .map((h) => ({ id: h.id, name: h.name }));
    const hostFacts = await gatherMultipleHostFacts(hostInfos);

    const { staticPrefix, dynamicSuffix } = buildSystemPrompt({
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

    // Resolve context window: DB-configured > pattern match > default 80k
    const contextWindow = getContextWindowForModel(model.modelId, activeProvider?.contextWindow);

    // ── 4. Load + compress message history ─────────────────────────────────
    const history = await compressContext(loadMessages(sessionId), { sessionId, model });

    // Dynamic suffix is prepended to the user message for the API call only.
    // This keeps the static prefix cacheable while still providing runtime
    // context (disk usage, failed services, safety mode) to the model.
    // The original userMessage (without suffix) is saved to the DB.
    const enhancedUserMessage = dynamicSuffix
      ? `[运行时上下文]\n${dynamicSuffix}\n\n---\n\n${userMessage}`
      : userMessage;

    let messages: CoreMessage[] = [...buildMessagesForCall(history, enhancedUserMessage)];

    // Prepend static system message with prompt-cache marker. The
    // providerOptions.anthropic.cacheControl tells the Anthropic provider
    // to cache this block. OpenAI-compatible providers ignore unknown
    // provider options, so this is safe for all providers.
    const systemMessage: CoreSystemMessage = {
      role: 'system',
      content: staticPrefix,
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
      },
    };
    messages = [systemMessage, ...messages];

    // Save original user message (not enhanced) to DB
    saveUserMessage(sessionId, userMessage);

    // ── 5. Create tools ────────────────────────────────────────────────────
    // modeHolder allows ExitPlanMode to switch mode mid-loop (plan -> operator)
    // without recreating the tools object. preExec reads from modeHolder.mode.
    const modeHolder: ModeHolder = { mode: safetyMode };

    // Denial tracker (P1-4): wraps onToolResult to detect when the user
    // repeatedly rejects authorizations. When the threshold is hit, a nudge
    // is injected suggesting the model use ask_user to clarify intent.
    const denialTracker = createDenialTracker();
    const wrappedOnToolResult = (result: ToolCallResult) => {
      if (result.authorization === 'rejected' || result.authorization === 'blocked') {
        recordDenial(denialTracker, result.toolName, result.blockedReason);
      } else if (result.success) {
        recordApproval(denialTracker);
      }
      params.onToolResult(result);
    };

    const tools = createTools({
      context,
      safetyMode,
      onToolCall: params.onToolCall,
      onToolResult: wrappedOnToolResult,
      onAuthorizationRequired: params.onAuthorizationRequired,
      onTodosUpdate: params.onTodosUpdate,
      onPlanApproval: params.onPlanApproval,
      onModeChange: params.onModeChange,
      onAskUser: params.onAskUser,
      modeHolder,
    });

    logger.info(
      `[Agent] Starting loop: session=${sessionId}, hosts=${hostIds.length}, mode=${safetyMode}, messages=${messages.length}`,
    );

    // ── 6. Stream text (with conclusion-nudge loop) ───────────────────────
    // Some models (e.g. glm-5.2) call tools then emit a short transitional
    // phrase and finish with reason 'stop' - never producing a substantive
    // conclusion. When we detect this stall pattern (tool calls happened +
    // short text + transitional words), we nudge the model with an explicit
    // "give your analysis" message and run another round. Capped at
    // MAX_NUDGE_ROUNDS to prevent infinite loops.
    const MAX_NUDGE_ROUNDS = 2;
    const STALL_TRANSITION_PATTERN = /让我|我来|继续|我先|接下来|下一步/;
    const STALL_TEXT_THRESHOLD = 150;

    // ── Output token escalation (P0-3.1) ──────────────────────────────────
    // When the model hits finishReason='length', escalate maxTokens from
    // 8k to 32k and inject a recovery nudge. Up to MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
    // recovery rounds to handle repeated truncation at 32k.
    const INITIAL_MAX_TOKENS = 8192;
    const ESCALATED_MAX_TOKENS = 32768;
    const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
    let currentMaxTokens = INITIAL_MAX_TOKENS;
    let outputTokensRecoveryCount = 0;

    // ── Token budget tracker (P0-3.3) ────────────────────────────────────
    // Tracks total tokens consumed. When the model stops inconclusively
    // (tools called + short text), checks if budget allows continuation.
    // Also detects diminishing returns after 3+ continuations.
    const MAX_CONTINUATIONS = 3;
    const budgetTracker = createBudgetTracker(contextWindow);

    let nudgeCount = 0;
    let toolCallCount = 0;
    let lastFinishReason = '';
    let stalled = true;

    while (stalled) {
      toolCallCount = 0;
      lastFinishReason = '';
      let roundText = '';

      // P0-2: Apply context compaction before each API call
      // Microcompact (truncate large tool results) + Snip (remove old tool results)
      messages = compactMessages(messages, budgetTracker.contextWindow);

      // Auto-retry wrapper for network errors (ECONNRESET, ETIMEDOUT, etc.)
      // The AI SDK internally retries 3 times but still throws for persistent
      // network issues. We add an outer retry layer that re-attempts with
      // the full message history so previously executed tool results are
      // not lost on transient failures.
      const MAX_API_RETRIES = 2;
      const RETRY_DELAYS_MS = [2000, 5000]; // 2s, 5s
      let apiRetryCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any = null;
      let streamConsumedSuccessfully = false;

      while (apiRetryCount <= MAX_API_RETRIES && !streamConsumedSuccessfully) {
        try {
          result = streamText({
            model,
            messages,
            tools,
            maxSteps,
            maxTokens: currentMaxTokens,
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
                // AbortError arrives here when the signal fires mid-stream - treat
                // it as a clean cancellation, not an error.
                if (err.name === 'AbortError' || abortSignal?.aborted) {
                  logger.info(
                    `[Agent] Stream aborted; preserving partial text (${roundText.length} chars)`,
                  );
                  break;
                }
                logger.error(`[Agent] Stream error: ${err.message}`);

                // Check if this is a transient network error worth retrying
                const isTransient = isTransientNetworkError(err);
                if (isTransient && apiRetryCount < MAX_API_RETRIES) {
                  apiRetryCount++;
                  logger.warn(
                    `[Agent] Transient stream error (attempt ${apiRetryCount}/${MAX_API_RETRIES}), retrying after ${RETRY_DELAYS_MS[apiRetryCount - 1]}ms: ${err.message}`,
                  );
                  // Don't throw - break out of the for-await loop to retry
                  throw new Error(`__RETRY__${err.message}`);
                }

                // Non-transient error or retries exhausted
                if (!roundText && !fullText) {
                  throw err;
                }
                // Partial text exists: inline the error so the user sees the
                // response was truncated, instead of silently completing.
                roundText += `\n\n---\n\u26a0\ufe0f \u54cd\u5e94\u4e2d\u65ad: ${err.message}`;
                break;
              }

              case 'finish': {
                const reason = part.finishReason;
                lastFinishReason = reason;
                // Track token usage for budget decisions (P0-3.3)
                if (part.usage) {
                  updateBudget(budgetTracker, {
                    promptTokens: part.usage.promptTokens,
                    completionTokens: part.usage.completionTokens,
                    totalTokens: part.usage.totalTokens,
                  });
                  // Emit context-usage event for the renderer to display
                  // the current context occupancy in the chat header.
                  // Use budgetTracker.totalTokensUsed (accumulated) as primary
                  // source since many OpenAI-compatible providers return
                  // promptTokens: 0 in streaming finish events.
                  const usedTokens =
                    budgetTracker.totalTokensUsed > 0
                      ? budgetTracker.totalTokensUsed
                      : (part.usage.promptTokens ?? estimateTokens(messages));
                  const percentage = Math.round((usedTokens / contextWindow) * 100);
                  params.onContextUsage?.({
                    sessionId,
                    usedTokens,
                    totalTokens: contextWindow,
                    percentage: Math.min(percentage, 100),
                  });
                }
                logger.info(
                  `[Agent] Loop finished: reason=${reason}, tokens=${part.usage?.totalTokens ?? 'unknown'}, totalUsed=${budgetTracker.totalTokensUsed}`,
                );
                if (reason === 'length') {
                  // P0-3.1: Two-stage maxTokens escalation
                  if (currentMaxTokens === INITIAL_MAX_TOKENS) {
                    // Stage 1: escalate from 8k to 32k
                    currentMaxTokens = ESCALATED_MAX_TOKENS;
                    logger.info(
                      `[Agent] finishReason=length, escalating maxTokens ${INITIAL_MAX_TOKENS} -> ${ESCALATED_MAX_TOKENS}`,
                    );
                  } else if (outputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
                    // Stage 2: inject recovery nudge, keep 32k
                    outputTokensRecoveryCount++;
                    logger.info(
                      `[Agent] finishReason=length at 32k, recovery round ${outputTokensRecoveryCount}/${MAX_OUTPUT_TOKENS_RECOVERY_LIMIT}`,
                    );
                  } else {
                    roundText += `\n\n---\n\u26a0\ufe0f Agent \u8fbe\u5230\u8f93\u51fa\u957f\u5ea6\u9650\u5236\uff0c\u54cd\u5e94\u88ab\u622a\u65ad\u3002\u53ef\u8f93\u5165\u201c\u7ee7\u7eed\u201d\u624b\u52a8\u5ef6\u7eed\u3002`;
                  }
                } else if (reason === 'tool-calls') {
                  roundText += `\n\n---\n\u26a0\ufe0f Agent \u8fbe\u5230\u6700\u5927\u6b65\u6570\u9650\u5236 (${maxSteps})\u3002\u5982\u679c\u4efb\u52a1\u5df2\u5b8c\u6210\uff0c\u8bf7\u67e5\u770b\u4e0a\u65b9\u7684\u7ed3\u679c\uff1b\u5982\u9700\u7ee7\u7eed\u6267\u884c\u672a\u5b8c\u6210\u7684\u64cd\u4f5c\uff0c\u8bf7\u91cd\u65b0\u63d0\u95ee\u3002`;
                } else if (reason === 'content-filter') {
                  roundText += `\n\n---\n\u26a0\ufe0f \u54cd\u5e94\u88ab\u5185\u5bb9\u8fc7\u6ee4\u5668\u622a\u65ad\u3002`;
                }
                break;
              }

              default:
                // tool-result, tool-input-start, etc. are handled inside each
                // tool's execute function via onToolCall/onToolResult callbacks.
                break;
            }
          }

          streamConsumedSuccessfully = true;
        } catch (retryErr) {
          const err = retryErr as Error;
          // Check if this is our internal retry signal
          if (err.message?.startsWith('__RETRY__')) {
            // Wait before retry
            const delayMs =
              RETRY_DELAYS_MS[Math.min(apiRetryCount - 1, RETRY_DELAYS_MS.length - 1)];
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            // Reset roundText for the retry - we'll re-stream from scratch
            roundText = '';
            continue;
          }

          // Not a retry signal - re-throw to outer catch
          throw err;
        }
      }

      // If we exhausted retries without success, surface the error
      if (!streamConsumedSuccessfully && !roundText && !fullText) {
        throw new Error(
          `\u65e0\u6cd5\u8fde\u63a5\u6a21\u578b API\uff0c\u5df2\u91cd\u8bd5 ${MAX_API_RETRIES} \u6b21\u5747\u5931\u8d25\u3002\u8bf7\u68c0\u67e5\u6a21\u578b\u670d\u52a1\u662f\u5426\u6b63\u5e38\u8fd0\u884c\u3002`,
        );
      }

      // If result is null (shouldn't happen, but TS safety), break
      if (!result) {
        stalled = false;
        break;
      }

      fullText += roundText;

      // ── P0-3.1: maxTokens escalation recovery ────────────────────────────
      // When finishReason='length', the model's output was truncated. We
      // escalate maxTokens (8k->32k) on first hit, then inject recovery
      // nudges on subsequent hits, up to MAX_OUTPUT_TOKENS_RECOVERY_LIMIT.
      if (lastFinishReason === 'length' && !abortSignal?.aborted) {
        const response = await result.response;
        const isStage1 = outputTokensRecoveryCount === 0;
        const isRecovery =
          outputTokensRecoveryCount > 0 &&
          outputTokensRecoveryCount <= MAX_OUTPUT_TOKENS_RECOVERY_LIMIT;

        if (isStage1 || isRecovery) {
          const nudgeContent = isStage1
            ? '\u8f93\u51fa\u56e0\u957f\u5ea6\u9650\u5236\u88ab\u622a\u65ad\u3002\u8bf7\u4ece\u4e0a\u6b21\u4e2d\u65ad\u5904\u76f4\u63a5\u7ee7\u7eed\u5b8c\u6210\u8f93\u51fa\uff0c\u4e0d\u8981\u91cd\u590d\u5df2\u8f93\u51fa\u5185\u5bb9\u3002'
            : '\u8f93\u51fa\u518d\u6b21\u88ab\u622a\u65ad\u3002\u8bf7\u4ece\u4e0a\u6b21\u4e2d\u65ad\u5904\u76f4\u63a5\u7ee7\u7eed\uff0c\u4e0d\u8981\u91cd\u590d\u5df2\u8f93\u51fa\u5185\u5bb9\u3002\u5c06\u5269\u4f59\u5de5\u4f5c\u5206\u89e3\u4e3a\u66f4\u5c0f\u7684\u6b65\u9aa4\u3002';
          messages = [
            ...messages,
            ...response.messages,
            { role: 'user' as const, content: nudgeContent },
          ];
          fullText += '\n\n';
          params.onTextStream('\n\n');
          stalled = true;
        } else {
          // Exhausted recovery attempts
          stalled = false;
        }
      }
      // ── P0-3.3: Stall detection + token budget continuation ──────────────
      else if (lastFinishReason === 'stop' && toolCallCount > 0 && !abortSignal?.aborted) {
        // P1-4: Check denial threshold first - if the user repeatedly rejected
        // authorizations, nudge the model to use ask_user instead of retrying.
        // This takes priority over the conclusion nudge because the model needs
        // user direction to proceed.
        const denialNudge = shouldNudgeAfterDenials(denialTracker);
        if (denialNudge.shouldNudge) {
          logger.info(
            `[Agent] Denial threshold hit (${denialTracker.consecutiveDenials} consecutive), nudging to use ask_user`,
          );
          const response = await result.response;
          messages = [
            ...messages,
            ...response.messages,
            {
              role: 'user' as const,
              content:
                `用户已连续 ${denialTracker.consecutiveDenials} 次拒绝操作授权` +
                (denialTracker.lastDeniedCommand
                  ? `（最近拒绝: ${denialTracker.lastDeniedCommand}）`
                  : '') +
                `。可能的原因：命令不被信任、需求不明确、或操作目标有误。` +
                `请使用 ask_user 工具向用户提问，确认正确的执行路径。不要盲目重试被拒绝的命令。`,
            },
          ];
          fullText += '\n\n';
          params.onTextStream('\n\n');
          stalled = true;
        } else {
          // Detect "inconclusive stop": model called tools but stopped without a
          // substantive conclusion. Two stall patterns:
          //  (a) short transitional phrase - text < threshold AND matches
          //      transition words
          //  (b) zero text after tool calls - model called tools, produced no
          //      assistant text, and stopped (user sees only tool cards, no analysis)
          const isTransitionStall =
            roundText.length > 0 &&
            roundText.length < STALL_TEXT_THRESHOLD &&
            STALL_TRANSITION_PATTERN.test(roundText);
          const isEmptyStall = roundText.length === 0;

          if ((isTransitionStall || isEmptyStall) && nudgeCount < MAX_NUDGE_ROUNDS) {
            // Existing nudge for inconclusive stop
            nudgeCount++;
            logger.info(
              `[Agent] Detected inconclusive stop (toolCalls=${toolCallCount}, text=${roundText.length} chars); nudging for conclusion, round ${nudgeCount}/${MAX_NUDGE_ROUNDS}`,
            );

            // CRITICAL: Use result.response.messages (not roundText) so the next
            // round sees the full assistant message INCLUDING tool calls and tool
            // results. Appending only roundText would strip tool context - the
            // nudge message would reference results the model cannot see,
            // risking hallucination or redundant re-runs.
            const response = await result.response;
            messages = [
              ...messages,
              ...response.messages,
              {
                role: 'user' as const,
                content:
                  '\u8bf7\u57fa\u4e8e\u4ee5\u4e0a\u5df2\u6267\u884c\u7684\u547d\u4ee4\u7ed3\u679c\uff0c\u7ed9\u51fa\u4f60\u7684\u5b9e\u8d28\u6027\u5206\u6790\u7ed3\u8bba\u3002\u5982\u679c\u8bca\u65ad\u4fe1\u606f\u5df2\u8db3\u591f\uff0c\u8bf7\u603b\u7ed3\u53d1\u73b0\u548c\u7ed3\u8bba\uff1b\u5982\u679c\u8fd8\u9700\u66f4\u591a\u4fe1\u606f\uff0c\u8bf7\u7ee7\u7eed\u6267\u884c\u547d\u4ee4\u3002\u4e0d\u8981\u53ea\u8f93\u51fa\u201c\u8ba9\u6211\u7ee7\u7eed\u68c0\u67e5\u201d\u4e4b\u7c7b\u7684\u58f0\u660e\u3002',
              },
            ];
            fullText += '\n\n';
            params.onTextStream('\n\n');
            stalled = true;
          } else {
            // P0-3.3: Token budget continuation - if budget allows, nudge to continue
            const budget = checkTokenBudget(budgetTracker, MAX_CONTINUATIONS);
            if (budget.canContinue && budgetTracker.continuationCount < MAX_CONTINUATIONS) {
              budgetTracker.continuationCount++;
              const pct = Math.round(
                (budgetTracker.totalTokensUsed / budgetTracker.contextWindow) * 100,
              );
              logger.info(
                `[Agent] Token budget continuation ${budgetTracker.continuationCount}/${MAX_CONTINUATIONS} (${pct}% used, ${budget.remainingTokens} tokens remaining)`,
              );
              const response = await result.response;
              messages = [
                ...messages,
                ...response.messages,
                {
                  role: 'user' as const,
                  content:
                    '\u8bf7\u7ee7\u7eed\u6267\u884c\u672a\u5b8c\u6210\u7684\u4efb\u52a1\uff0c\u4e0d\u8981\u603b\u7ed3\u3002',
                },
              ];
              fullText += '\n\n';
              params.onTextStream('\n\n');
              stalled = true;
            } else {
              if (budget.reason === 'budget_exhausted') {
                logger.info(
                  `[Agent] Token budget exhausted (${budgetTracker.totalTokensUsed}/${budgetTracker.contextWindow} tokens), stopping`,
                );
              } else if (budget.reason === 'diminishing_returns') {
                logger.info(
                  `[Agent] Diminishing returns detected, stopping (last delta=${budgetTracker.lastDeltaTokens} tokens)`,
                );
              }
              stalled = false;
            }
          }
        }
      } else {
        stalled = false;
      }
    }

    // ── 7. Save assistant message ──────────────────────────────────────────
    if (fullText) {
      saveAssistantMessage(sessionId, fullText);
    }

    // ── 8. Complete ────────────────────────────────────────────────────────
    logger.info(
      `[Agent] Loop complete: ${fullText.length} chars output (nudges=${nudgeCount}, continuations=${budgetTracker.continuationCount})`,
    );
    params.onComplete(fullText);
  } catch (err) {
    const error = err as Error;
    // AbortError surfacing from streamText - treat as clean cancellation.
    if (error.name === 'AbortError' || abortSignal?.aborted) {
      logger.info(`[Agent] Loop aborted via AbortError; partial text preserved by caller`);
      // Save partial text even on abort so the work isn't lost
      if (fullText) {
        saveAssistantMessage(sessionId, fullText);
      }
      return;
    }
    logger.error(`[Agent] Loop failed: ${error.message}`, error);

    // Save partial assistant message so executed tool calls aren't lost.
    // The agent may have completed several steps before the error occurred.
    if (fullText) {
      const errorNote = `\n\n---\n\u26a0\ufe0f \u6267\u884c\u8fc7\u7a0b\u4e2d\u53d1\u751f\u9519\u8bef\uff0c\u5df2\u4fdd\u5b58\u5f53\u524d\u8fdb\u5ea6\u3002\u9519\u8bef\u4fe1\u606f: ${error.message}`;
      fullText += errorNote;
      saveAssistantMessage(sessionId, fullText);
      // Call onComplete instead of onError so the renderer treats it as a
      // completed (but partial) message, preserving the conversation flow.
      params.onComplete(fullText);
    } else {
      const friendly = formatModelError(error);
      params.onError(new Error(`${friendly}\n\n\u8be6\u7ec6\u4fe1\u606f: ${error.message}`));
    }
  }
}

// Format model API errors into user-friendly messages.
function formatModelError(err: Error): string {
  const msg = err.message;
  if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('invalid api key')) {
    return '\u6a21\u578b API Key \u65e0\u6548\u6216\u5df2\u8fc7\u671f\u3002\u8bf7\u5728\u8bbe\u7f6e\u9875\u68c0\u67e5\u6a21\u578b\u914d\u7f6e\u3002';
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Rate limit')) {
    return '\u6a21\u578b API \u8bf7\u6c42\u9891\u7387\u8d85\u9650\u3002\u8bf7\u7a0d\u540e\u91cd\u8bd5\u6216\u68c0\u67e5 API \u914d\u989d\u3002';
  }
  if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
    return '\u6a21\u578b\u670d\u52a1\u7aef\u9519\u8bef\u3002\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002';
  }
  if (
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('fetch failed') ||
    msg.includes('Cannot connect to API')
  ) {
    return '\u65e0\u6cd5\u8fde\u63a5\u6a21\u578b API \u7aef\u70b9\u3002\u8fd9\u901a\u5e38\u662f\u7531\u4e8e\u7aef\u70b9 URL \u4e0d\u6b63\u786e\uff08\u9700\u4ee5 /v1 \u7ed3\u5c3e\uff09\u3001\u6a21\u578b\u540d\u79f0\u4e0d\u5b58\u5728\u3001\u6216\u7f51\u7edc\u4e0d\u901a\u5bfc\u81f4\u3002\u8bf7\u5728\u8bbe\u7f6e\u9875\u68c0\u67e5\u6a21\u578b\u914d\u7f6e\u5e76\u70b9\u51fb\u201c\u6d4b\u8bd5\u8fde\u63a5\u201d\u3002';
  }
  if (msg.includes('No active model provider')) {
    return '\u672a\u914d\u7f6e\u6d3b\u8dc3\u6a21\u578b\u4f9b\u5e94\u5546\u3002\u8bf7\u5148\u5728\u8bbe\u7f6e\u9875\u914d\u7f6e\u6a21\u578b\u3002';
  }
  return msg;
}

// Check if an error is a transient network error worth auto-retrying.
// ECONNRESET, ETIMEDOUT, EPIPE, etc. are typically temporary and benefit
// from a short delay + retry, especially with local/self-hosted models.
function isTransientNetworkError(err: Error): boolean {
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
