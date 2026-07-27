// Session cost & token-usage persistence (V3-01).
//
// One row per agent turn (streamText finish). Aggregated by getSessionCostTotal
// for the session-sidebar cost display and budget-alert logic.
//
// Token accounting is independent of pricing: even when no prices are
// configured we still persist the token totals (they're useful on their own
// for context-occupancy / model-capacity analysis). estimated_usd is 0 in that
// case.
import { getDb } from './database.js';
import { estimateCost, type TokenUsage, type ModelPricing } from '../agent/cost-tracking.js';

export interface SessionCostTotal extends TokenUsage {
  estimatedUsd: number;
}

/** Persist one turn's token usage + estimated USD cost. */
export function recordSessionCost(
  sessionId: string,
  usage: TokenUsage,
  pricing: ModelPricing | undefined,
  modelProviderId?: string,
): void {
  const estimatedUsd = pricing ? estimateCost(usage, pricing).totalCost : 0;
  getDb()
    .prepare(
      `
        INSERT INTO session_costs
          (session_id, model_provider_id, prompt_tokens, completion_tokens,
           total_tokens, cache_read_tokens, cache_creation_tokens, estimated_usd)
        VALUES
          (@sessionId, @modelProviderId, @promptTokens, @completionTokens,
           @totalTokens, @cacheReadTokens, @cacheCreationTokens, @estimatedUsd)
        `,
    )
    .run({
      sessionId,
      modelProviderId: modelProviderId ?? null,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      estimatedUsd,
    });
}

/** Sum all token + cost rows for a session. Zero when no rows exist. */
export function getSessionCostTotal(sessionId: string): SessionCostTotal {
  const row = getDb()
    .prepare(
      `
        SELECT
          COALESCE(SUM(prompt_tokens), 0)         AS promptTokens,
          COALESCE(SUM(completion_tokens), 0)     AS completionTokens,
          COALESCE(SUM(total_tokens), 0)          AS totalTokens,
          COALESCE(SUM(cache_read_tokens), 0)     AS cacheReadTokens,
          COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
          COALESCE(SUM(estimated_usd), 0)         AS estimatedUsd
        FROM session_costs
        WHERE session_id = ?
        `,
    )
    .get(sessionId) as SessionCostTotal | null | undefined;

  if (!row) {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedUsd: 0,
    };
  }
  return {
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    estimatedUsd: row.estimatedUsd,
  };
}
