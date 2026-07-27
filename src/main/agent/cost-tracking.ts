// Cost & token tracking for agent runs (V3-01).
//
// Three pure functions:
//  - extractUsage(): normalize an AI SDK `finish` part's usage + providerMetadata
//    into a flat TokenUsage record (prompt/completion/total + Anthropic cache tokens).
//  - estimateCost(): turn a TokenUsage + pricing table into an estimated USD figure.
//  - sumUsage(): accumulate token counts across multiple turns.
//
// Anthropic convention (verified against @ai-sdk/anthropic dist index.js:687):
// the SDK maps `usage.promptTokens` = the API's `input_tokens` field ONLY - i.e.
// the NON-cached input tokens, billed at the full input rate. Cache-read and
// cache-creation tokens arrive SEPARATELY under `providerMetadata.anthropic`
// (cacheReadInputTokens / cacheCreationInputTokens) and are billed at their own
// (cheaper) rates. The four pools (non-cache input, cache-read, cache-creation,
// output) are MUTUALLY EXCLUSIVE and billed ADDITIVELY - no subtraction. For
// providers that don't report cache tokens (cacheRead=cacheCreation=0), the
// formula collapses to input*inputRate + output*outputRate.

/** Per-turn normalized token usage. All fields non-negative integers. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Per-million-token pricing for a model provider. All rates in USD. */
export interface ModelPricing {
  inputPricePerMTok?: number;
  outputPricePerMTok?: number;
  cacheReadPricePerMTok?: number;
  cacheCreationPricePerMTok?: number;
}

/** Cost breakdown for a single turn, in USD. */
export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheCreationCost: number;
  totalCost: number;
}

const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Input shape: the subset of an AI SDK `finish` part we care about.
 * Kept loose (optional fields) so callers can pass the raw part directly.
 */
interface FinishUsageInput {
  usage?:
    | {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      }
    | undefined;
  // providerMetadata is Record<string, Record<string, unknown>>; Anthropic nests
  // cacheReadInputTokens / cacheCreationInputTokens under the 'anthropic' key.
  providerMetadata?: Record<string, Record<string, unknown>>;
}

/** Coerce a maybe-undefined number to a non-negative integer (0 if absent/NaN). */
function toCount(value: number | undefined): number {
  if (value === undefined || value === null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * Normalize an AI SDK `finish` part's usage + providerMetadata into a flat
 * TokenUsage record. Returns null when usage is entirely absent (signals "no
 * data" rather than a misleading all-zero record - some providers omit usage
 * on streaming finish events).
 */
export function extractUsage(part: FinishUsageInput): TokenUsage | null {
  if (!part.usage) return null;

  // Anthropic reports cache tokens under providerMetadata.anthropic.
  const anthropic = part.providerMetadata?.anthropic as
    { cacheReadInputTokens?: number; cacheCreationInputTokens?: number } | undefined;

  return {
    promptTokens: toCount(part.usage.promptTokens),
    completionTokens: toCount(part.usage.completionTokens),
    totalTokens: toCount(part.usage.totalTokens),
    cacheReadTokens: toCount(anthropic?.cacheReadInputTokens),
    cacheCreationTokens: toCount(anthropic?.cacheCreationInputTokens),
  };
}

/**
 * Estimate USD cost for a turn from its token usage + a pricing table.
 *
 * Anthropic convention (verified against @ai-sdk/anthropic dist): the SDK maps
 * `usage.promptTokens` = the API's `input_tokens` field ONLY - i.e. the non-cached
 * input tokens, billed at the full input rate. Cache-read and cache-creation
 * tokens arrive SEPARATELY under `providerMetadata.anthropic` and are billed at
 * their own (cheaper) rates. The three pools are mutually exclusive, so the
 * total is a plain sum of the four cost components - no subtraction needed.
 * For providers that don't report cache tokens (cacheRead=cacheCreation=0),
 * this collapses to input*inputRate + output*outputRate.
 */
export function estimateCost(usage: TokenUsage, pricing: ModelPricing): CostEstimate {
  const inputRate = pricing.inputPricePerMTok ?? 0;
  const outputRate = pricing.outputPricePerMTok ?? 0;
  const cacheReadRate = pricing.cacheReadPricePerMTok ?? 0;
  const cacheCreationRate = pricing.cacheCreationPricePerMTok ?? 0;

  // promptTokens is the non-cached input (Anthropic input_tokens); cache tokens
  // are separate, mutually-exclusive pools - billed additively, not subtracted.
  const inputCost = (usage.promptTokens / 1_000_000) * inputRate;
  const outputCost = (usage.completionTokens / 1_000_000) * outputRate;
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * cacheReadRate;
  const cacheCreationCost = (usage.cacheCreationTokens / 1_000_000) * cacheCreationRate;

  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheCreationCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheCreationCost,
  };
}

/** Accumulate token counts across multiple turns into a single sum. */
export function sumUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce<TokenUsage>(
    (acc, u) => ({
      promptTokens: acc.promptTokens + u.promptTokens,
      completionTokens: acc.completionTokens + u.completionTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
      cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + u.cacheCreationTokens,
    }),
    { ...ZERO_USAGE },
  );
}
