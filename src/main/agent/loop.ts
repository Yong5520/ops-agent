import { streamText } from 'ai';
import type { CoreSystemMessage, CoreMessage } from 'ai';
import { createLanguageModel, resolveModelProvider, validateModelExists } from './providers.js';
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
import { createBudgetTracker, updateBudget } from './token-budget.js';
import { evaluateStallDecision } from './stall-detection.js';
import { createThinkingStream } from './thinking-stream.js';
import { detectRepetition } from './loop-repetition-guard.js';
import { extractUsage, type ModelPricing } from './cost-tracking.js';
import { recordSessionCost } from '../storage/cost-store.js';
import { taskListsStore } from '../storage/task-lists.js';
import {
  formatExecutionErrorMessage,
  isTransientNetworkError,
  isUnreachableEndpoint,
} from './model-errors.js';
import {
  createDenialTracker,
  recordDenial,
  recordApproval,
  shouldNudgeAfterDenials,
} from './denial-tracking.js';
import type { ModeHolder } from './tools/exit-plan-mode.js';
import { hasSubstantiveText, EMPTY_RESPONSE_MARKER } from './message-text.js';
import { hostsStore } from '../storage/hosts.js';
import { gatherMultipleHostFacts } from './facts.js';
import { attachmentsStore } from '../storage/attachments.js';
import { logger } from '../utils/logger.js';
import type { AgentLoopParams, SessionContext, ToolCallResult } from './types.js';
import type { ThinkingBlock, TodoItem } from '../../shared/types.js';

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
  // Per-round clean answer text (thinking stripped). Declared at this scope so
  // the thinking-stream parser's onText callback can append to it via closure;
  // reset to '' at the start of each stalled round.
  let roundText = '';
  // Thinking blocks collected during the run - persisted with the assistant
  // message. Declared outside try so the catch block can save partial work.
  const thinkingBlocks: ThinkingBlock[] = [];
  // Cumulative completion tokens across ALL finish parts in this run (a run can
  // span multiple streamText calls: tool-call rounds + nudges/continuations).
  // Persisted to messages.token_count so it reflects the whole assistant turn,
  // not just the last sub-round. (Per-turn rows in session_costs stay correct
  // via recordSessionCost, which uses turnUsage for each individual turn.)
  let cumulativeCompletionTokens = 0;

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

    // Read back the persisted todo list so a resumed session continues from
    // the last completed step instead of re-planning from scratch. Wrapped in
    // try/catch so a transient DB issue never aborts the run - worst case the
    // model runs without task-list injection (pre-fix behavior).
    let persistedTodos: TodoItem[] | undefined;
    try {
      persistedTodos = taskListsStore.get(sessionId) ?? undefined;
    } catch (err) {
      logger.warn(`[Agent] Failed to load task list for session ${sessionId}: ${err}`);
    }

    const { staticPrefix, dynamicSuffix } = buildSystemPrompt({
      selectedHostIds: hostIds,
      safetyMode,
      hostFacts,
      todos: persistedTodos,
    });

    // ── 3. Resolve this session's model (needed before context compression) ─
    // A per-session override (params.modelProviderId or the session's stored
    // model_provider_id) wins over the global active default. resolveModelProvider
    // returns the provider row with a decrypted, validated apiKey; createLanguageModel
    // turns it into a Vercel AI SDK LanguageModel for streamText.
    const provider = resolveModelProvider(sessionId, params.modelProviderId);
    logger.info(
      `[Agent] Pre-flight check: model="${provider.modelName}" type=${provider.type} endpoint=${provider.endpoint}`,
    );
    // validateModelExists probes the /models endpoint for openai-compatible /
    // openai types (no-op for anthropic). Some proxies (New API) reset the TCP
    // connection (ECONNRESET) on an invalid model name instead of a clean error.
    await validateModelExists(provider);
    const model = createLanguageModel(provider);

    // Resolve context window: DB-configured > pattern match > default 80k
    const contextWindow = getContextWindowForModel(model.modelId, provider.contextWindow);

    // ── 4. Load + compress message history ─────────────────────────────────
    const history = await compressContext(loadMessages(sessionId), { sessionId, model });

    // Dynamic suffix is prepended to the user message for the API call only.
    // This keeps the static prefix cacheable while still providing runtime
    // context (disk usage, failed services, safety mode) to the model.
    // The original userMessage (without suffix) is saved to the DB.
    const enhancedUserMessage = dynamicSuffix
      ? `[运行时上下文]\n${dynamicSuffix}\n\n---\n\n${userMessage}`
      : userMessage;

    let messages: CoreMessage[] = [
      ...buildMessagesForCall(history, enhancedUserMessage, params.attachments),
    ];

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

    // Save original user message (not enhanced) to DB, then save any image
    // attachments to disk + DB so they're available for history reload.
    const userMessageId = saveUserMessage(sessionId, userMessage);
    if (params.attachments && params.attachments.length > 0) {
      for (const att of params.attachments) {
        try {
          attachmentsStore.save({
            messageId: userMessageId,
            sessionId,
            data: att.data,
            mimeType: att.mimeType,
            originalName: att.originalName,
          });
        } catch (err) {
          logger.error(`[Agent] Failed to save attachment: ${(err as Error).message}`);
        }
      }
      logger.info(
        `[Agent] Saved ${params.attachments.length} attachment(s) for message ${userMessageId}`,
      );
    }

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

    // ── Token budget tracker ─────────────────────────────────────────────
    // Tracks total tokens consumed for context-usage reporting. The
    // continuation-nudge feature that previously used this for deciding
    // whether to push the model to "continue unfinished tasks" has been
    // removed (it caused over-action: agent fixing when user only asked
    // to analyze).
    const budgetTracker = createBudgetTracker(contextWindow);

    let nudgeCount = 0;
    let toolCallCount = 0;
    let lastFinishReason = '';
    let stalled = true;

    // Thinking-stream parser - splits <think> tags / reasoning parts out of
    // the text stream so each thinking block renders as its own collapsible
    // card. Persisted across nudge rounds so blockIds stay unique within the
    // turn; roundText is reset per round (above) so the parser's onText
    // callback always accumulates into the current round's clean text.
    const thinkingContent = new Map<string, string>();
    // Repetition guard (qwen loop): set when the streamed output starts
    // repeating the same phrase. The stream-consumption loop checks this and
    // breaks out, then we surface a friendly message + abort the model stream.
    // Wrapped in a mutable ref object so the onText closure can assign to it
    // and the outer code sees the update (TS control-flow narrowing on a
    // closure-mutated `let` would otherwise narrow it back to `null`).
    const repetitionRef: { current: { phrase: string; repeatCount: number } | null } = {
      current: null,
    };
    const thinkingStream = createThinkingStream({
      onText: (delta) => {
        roundText += delta;
        params.onTextStream(delta);
        // Cheap tail-only scan; only run while no repetition has been seen yet
        // and the user hasn't cancelled.
        if (!repetitionRef.current && !abortSignal?.aborted) {
          const rep = detectRepetition(roundText);
          if (rep) {
            repetitionRef.current = rep;
            logger.warn(
              `[Agent] Repetition detected (phrase=${rep.phrase.length} chars, ` +
                `repeated ${rep.repeatCount}x); will abort to avoid a stuck loop`,
            );
          }
        }
      },
      onThinkingOpen: (blockId, absorbPrecedingText) => {
        thinkingContent.set(blockId, '');
        // Stray-closer absorb (qwen pattern): the reasoning was already
        // streamed as answer text via onText. Retract it from roundText so
        // fullText/persistence only keeps the clean answer, and forward the
        // count so the renderer retracts it from its live text segment into
        // this thinking card.
        if (absorbPrecedingText && absorbPrecedingText > 0) {
          roundText = roundText.slice(0, -absorbPrecedingText);
        }
        params.onThinkingStream?.({ blockId, absorbPrecedingText });
      },
      onThinkingDelta: (blockId, delta) => {
        thinkingContent.set(blockId, (thinkingContent.get(blockId) ?? '') + delta);
        params.onThinkingStream?.({ blockId, delta });
      },
      onThinkingClose: (blockId, durationMs) => {
        const content = thinkingContent.get(blockId) ?? '';
        // Skip empty thinking blocks so the UI never shows an empty card.
        if (content) {
          thinkingBlocks.push({ id: blockId, content, durationMs });
        }
        params.onThinkingStream?.({ blockId, closed: true, durationMs });
      },
    });

    while (stalled) {
      toolCallCount = 0;
      lastFinishReason = '';
      roundText = '';

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
            // Repetition guard: the model is stuck re-stating the same phrase.
            // Stop consuming so we don't let it spin to maxSteps. The friendly
            // message is appended after the loop breaks (below).
            if (repetitionRef.current) {
              logger.info(`[Agent] Breaking stream: repetition detected`);
              break;
            }
            switch (part.type) {
              case 'text-delta': {
                // Route through the thinking parser: <think>...</think> tags
                // become thinking blocks, the rest is clean answer text.
                thinkingStream.feedTextDelta(part.textDelta);
                break;
              }

              case 'reasoning': {
                // SDK reasoning_content (providers that return reasoning as a
                // separate field). Appends to the current thinking block.
                thinkingStream.feedReasoningDelta(part.textDelta);
                break;
              }

              case 'tool-call': {
                // Close any open thinking block so this tool attaches to the
                // preceding thought in the UI's chronological transcript.
                thinkingStream.closeCurrent();
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

                // Fix B: connect-timeout / connection-refused means the host
                // is dead. Skip the retry cycle (which would waste ~2 min) and
                // surface the error immediately. Retrying a dead endpoint is
                // pointless - the user needs to fix connectivity, not wait.
                if (isUnreachableEndpoint(err)) {
                  logger.warn(
                    `[Agent] Endpoint unreachable (${err.message.slice(0, 80)}), failing fast without retry`,
                  );
                  throw err;
                }

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
                // Partial text exists: inline the tagged error so the user
                // sees the response was truncated AND where the failure came
                // from (\u6a21\u578b\u5f02\u5e38 vs \u6267\u884c\u5f02\u5e38), instead of silently completing.
                roundText += `\n\n---\n${formatExecutionErrorMessage(err)}\n\uff08\u54cd\u5e94\u4e2d\u65ad\uff09`;
                break;
              }

              case 'finish': {
                // Finalize any thinking block left open at the end of this
                // streamText call (model stopped mid-think, or trailing think
                // with no closing tag).
                thinkingStream.closeCurrent();
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
                // V3-01: cost & token tracking. extractUsage normalizes the
                // finish part's usage + providerMetadata (Anthropic cache tokens)
                // into a flat record; recordSessionCost persists one
                // session_costs row per turn + estimated USD from the provider's
                // pricing. Token accounting persists even when pricing is unset.
                const turnUsage = extractUsage(part);
                if (turnUsage) {
                  // Accumulate completion tokens across all sub-rounds so the
                  // persisted messages.token_count reflects the full turn.
                  cumulativeCompletionTokens += turnUsage.completionTokens;
                  const pricing: ModelPricing = {
                    inputPricePerMTok: provider.inputPricePerMTok,
                    outputPricePerMTok: provider.outputPricePerMTok,
                    cacheReadPricePerMTok: provider.cacheReadPricePerMTok,
                    cacheCreationPricePerMTok: provider.cacheCreationPricePerMTok,
                  };
                  try {
                    recordSessionCost(sessionId, turnUsage, pricing, provider.id);
                  } catch (costErr) {
                    // Cost persistence must never break the agent loop - log only.
                    logger.warn(
                      `[Agent] Failed to record session cost: ${(costErr as Error).message}`,
                    );
                  }
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

      // If we exhausted retries without success, surface a tagged error so
      // the user sees this as a model\u5f02\u5e38 (connection), not a raw exception.
      if (!streamConsumedSuccessfully && !roundText && !fullText) {
        const retryErr = new Error(
          `\u65e0\u6cd5\u8fde\u63a5\u6a21\u578b API\uff0c\u5df2\u91cd\u8bd5 ${MAX_API_RETRIES} \u6b21\u5747\u5931\u8d25\u3002\u8bf7\u68c0\u67e5\u6a21\u578b\u670d\u52a1\u662f\u5426\u6b63\u5e38\u8fd0\u884c\u3002`,
        );
        throw new Error(formatExecutionErrorMessage(retryErr));
      }

      // If result is null (shouldn't happen, but TS safety), break
      if (!result) {
        stalled = false;
        break;
      }

      // Repetition guard fired: surface a friendly message instead of letting
      // the model spin to maxSteps. End the loop (no nudge).
      if (repetitionRef.current) {
        const rep = repetitionRef.current;
        const note = `\n\n---\n⚠️ 检测到模型输出重复（“${rep.phrase.slice(0, 40)}…”重复 ${rep.repeatCount} 次），已自动停止以避免死循环。这通常是思考型模型在工具调用上的限制。建议重新描述任务或切换模型。`;
        roundText += note;
        params.onTextStream(note);
        fullText += roundText;
        stalled = false;
        continue;
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
          // Evaluate whether this stop is a stall (needs a conclusion nudge)
          // or a substantive response (model is done, stop).
          const stallDecision = evaluateStallDecision({
            finishReason: lastFinishReason,
            toolCallCount,
            roundText,
            nudgeCount,
            maxNudgeRounds: MAX_NUDGE_ROUNDS,
            transitionPattern: STALL_TRANSITION_PATTERN,
            textThreshold: STALL_TEXT_THRESHOLD,
          });

          if (stallDecision.shouldNudge) {
            // Conclusion nudge for transition/empty stall
            nudgeCount++;
            logger.info(
              `[Agent] Detected ${stallDecision.reason} (toolCalls=${toolCallCount}, text=${roundText.length} chars); nudging for conclusion, round ${nudgeCount}/${MAX_NUDGE_ROUNDS}`,
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
            // Model produced substantive text or exhausted nudge rounds.
            // Do NOT continue - the model has completed its response.
            // Previously a "token budget continuation" nudge fired here
            // ("continue unfinished tasks, don't summarize"), causing
            // over-action (agent fixing when user only asked to analyze).
            logger.info(
              `[Agent] Stopping after substantive response (reason=${stallDecision.reason}, toolCalls=${toolCallCount}, text=${roundText.length} chars)`,
            );
            stalled = false;
          }
        }
      } else {
        stalled = false;
      }
    }

    // ── 7. Save assistant message ──────────────────────────────────────────
    // Final safety close for any thinking block left open (e.g. loop exited
    // via a path that didn't hit the finish handler).
    thinkingStream.closeCurrent();
    if (hasSubstantiveText(fullText)) {
      // Persist cumulative completion tokens across all sub-rounds of this turn
      // (tool-call rounds + nudges/continuations), not just the last finish.
      saveAssistantMessage(
        sessionId,
        fullText,
        thinkingBlocks,
        cumulativeCompletionTokens > 0 ? cumulativeCompletionTokens : undefined,
      );
    } else {
      // Whitespace-only fullText (e.g. nudge rounds that appended "\n\n" but
      // never elicited real text): persist a marker so the turn is CLOSED in
      // history. A blank/whitespace message would read as an unfinished turn,
      // causing the next user question to be treated as a continuation of the
      // prior pending task (orphan-task resumption - the gpu-16-36 incident).
      saveAssistantMessage(sessionId, EMPTY_RESPONSE_MARKER, []);
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
      // Save partial text even on abort so the work isn't lost. If no partial
      // text was produced, save a cancellation marker so the aborted turn is
      // closed in history (same orphan-message prevention as the failure path).
      // Use hasSubstantiveText: whitespace-only fullText (e.g. "\n\n" from a
      // nudge round) must NOT be saved as a blank real message.
      if (hasSubstantiveText(fullText)) {
        saveAssistantMessage(sessionId, fullText, thinkingBlocks);
      } else {
        saveAssistantMessage(sessionId, '已取消。未执行任何操作。', []);
      }
      return;
    }
    logger.error(`[Agent] Loop failed: ${error.message}`, error);

    // Save partial assistant message so executed tool calls aren't lost.
    // The agent may have completed several steps before the error occurred.
    // Use hasSubstantiveText: whitespace-only fullText must fall through to
    // the failure marker instead of being saved as a blank real message.
    if (hasSubstantiveText(fullText)) {
      // Tag the error so the user sees WHERE the failure came from (\u6a21\u578b\u5f02\u5e38 vs
      // \u6267\u884c\u5f02\u5e38) instead of a raw exception string.
      const errorNote = `\n\n---\n${formatExecutionErrorMessage(error)}\n\u5df2\u4fdd\u5b58\u5f53\u524d\u8fdb\u5ea6\u3002`;
      fullText += errorNote;
      saveAssistantMessage(sessionId, fullText, thinkingBlocks);
      // Call onComplete instead of onError so the renderer treats it as a
      // completed (but partial) message, preserving the conversation flow.
      params.onComplete(fullText);
    } else {
      // No partial text was produced (the failure happened before/during the
      // first streamText call). Save a "failure marker" assistant message so
      // the failed turn is CLOSED in conversation history - otherwise the
      // unanswered user message becomes an orphan that the model treats as a
      // pending task on the NEXT turn, causing it to re-run the failed task
      // instead of answering the new question (context pollution).
      const friendly = formatExecutionErrorMessage(error);
      const failureMarker = `${friendly}\n\n\u672a\u6267\u884c\u4efb\u4f55\u64cd\u4f5c\u3002\u8bf7\u5728\u6392\u67e5\u95ee\u9898\u540e\u91cd\u65b0\u63d0\u95ee\u3002`;
      saveAssistantMessage(sessionId, failureMarker, []);
      params.onError(new Error(friendly));
    }
  }
}
