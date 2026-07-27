// Unit tests for cost-tracking: usage extraction + cost estimation.
//
// These are PURE functions (no DB, no IPC), so they run directly in vitest
// without the fake-DB shim. extractUsage normalizes the AI SDK `finish` part's
// `usage` + `providerMetadata` into a flat TokenUsage record. estimateCost
// turns a TokenUsage + a pricing table into an estimated USD figure.
//
// AI SDK finish part shape (per @ai-sdk/provider/dist/index.d.ts):
//   { type: 'finish', finishReason, providerMetadata?, usage: { promptTokens,
//     completionTokens, totalTokens } }
// Anthropic cache tokens arrive under providerMetadata.anthropic:
//   { cacheReadInputTokens?, cacheCreationInputTokens? }
import { describe, it, expect } from 'vitest';
import { extractUsage, estimateCost, sumUsage } from '../cost-tracking.js';

describe('extractUsage', () => {
  it('reads prompt/completion/total from a plain usage object', () => {
    const usage = extractUsage({
      usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 },
    });
    expect(usage).toEqual({
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('extracts Anthropic cache tokens from providerMetadata', () => {
    const usage = extractUsage({
      usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 },
      providerMetadata: {
        anthropic: {
          cacheReadInputTokens: 800,
          cacheCreationInputTokens: 150,
        },
      },
    });
    expect(usage).not.toBeNull();
    expect(usage!.cacheReadTokens).toBe(800);
    expect(usage!.cacheCreationTokens).toBe(150);
  });

  it('treats cache tokens as 0 when providerMetadata is absent', () => {
    const usage = extractUsage({
      usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 },
    });
    expect(usage).not.toBeNull();
    expect(usage!.cacheReadTokens).toBe(0);
    expect(usage!.cacheCreationTokens).toBe(0);
  });

  it('returns null when usage is missing entirely', () => {
    // Some providers omit usage on streaming finish events. extractUsage must
    // signal "no data" rather than emit a misleading all-zero record.
    expect(extractUsage({})).toBeNull();
    expect(extractUsage({ usage: undefined })).toBeNull();
  });

  it('coerces undefined sub-fields to 0 without crashing', () => {
    // OpenAI-compatible providers sometimes return partial usage
    // (promptTokens: 0, no completionTokens).
    const usage = extractUsage({
      usage: { promptTokens: 0 },
    });
    expect(usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('is tolerant of a non-anthropic providerMetadata', () => {
    const usage = extractUsage({
      usage: { promptTokens: 500, completionTokens: 50, totalTokens: 550 },
      providerMetadata: {
        openai: { someFlag: true },
      },
    });
    expect(usage).not.toBeNull();
    expect(usage!.cacheReadTokens).toBe(0);
    expect(usage!.cacheCreationTokens).toBe(0);
  });
});

describe('estimateCost', () => {
  const pricing = {
    inputPricePerMTok: 3.0, // $3 / 1M input tokens
    outputPricePerMTok: 15.0, // $15 / 1M output tokens
    cacheReadPricePerMTok: 0.3, // $0.30 / 1M cache-read tokens
    cacheCreationPricePerMTok: 3.75, // $3.75 / 1M cache-write tokens
  };

  it('computes input + output cost at per-million-token rates', () => {
    const cost = estimateCost(
      {
        promptTokens: 1_000_000,
        completionTokens: 500_000,
        totalTokens: 1_500_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      pricing,
    );
    // 1M input * $3 + 0.5M output * $15 = $3 + $7.5 = $10.5
    expect(cost.inputCost).toBeCloseTo(3.0, 6);
    expect(cost.outputCost).toBeCloseTo(7.5, 6);
    expect(cost.cacheReadCost).toBe(0);
    expect(cost.cacheCreationCost).toBe(0);
    expect(cost.totalCost).toBeCloseTo(10.5, 6);
  });

  it('adds cache read + cache creation cost', () => {
    const cost = estimateCost(
      {
        promptTokens: 1_000_000,
        completionTokens: 0,
        totalTokens: 1_000_000,
        cacheReadTokens: 800_000,
        cacheCreationTokens: 200_000,
      },
      pricing,
    );
    // cache read: 0.8M * $0.3 = $0.24
    // cache creation: 0.2M * $3.75 = $0.75
    expect(cost.cacheReadCost).toBeCloseTo(0.24, 6);
    expect(cost.cacheCreationCost).toBeCloseTo(0.75, 6);
    expect(cost.totalCost).toBeCloseTo(3.0 + 0.24 + 0.75, 6);
  });

  it('counts cache-read/creation tokens as separate additive pools', () => {
    // Verified against @ai-sdk/anthropic: usage.promptTokens = the API's
    // input_tokens field ONLY (non-cached input). Cache-read and cache-creation
    // tokens arrive separately under providerMetadata.anthropic and are billed
    // at their own (cheaper) rates. The three input pools are mutually
    // exclusive, so total = input*inputRate + cacheRead*cacheReadRate +
    // cacheCreation*cacheCreationRate + output*outputRate (no subtraction).
    const cost = estimateCost(
      {
        promptTokens: 50_000, // non-cached input only (Anthropic input_tokens)
        completionTokens: 100_000,
        totalTokens: 1_100_000,
        cacheReadTokens: 800_000,
        cacheCreationTokens: 150_000,
      },
      pricing,
    );
    expect(cost.inputCost).toBeCloseTo(0.15, 6); // 50k * $3
    expect(cost.cacheReadCost).toBeCloseTo(0.24, 6); // 800k * $0.3
    expect(cost.cacheCreationCost).toBeCloseTo(0.5625, 6); // 150k * $3.75
    expect(cost.outputCost).toBeCloseTo(1.5, 6); // 100k * $15
    expect(cost.totalCost).toBeCloseTo(0.15 + 0.24 + 0.5625 + 1.5, 6);
  });

  it('returns zero cost for a zero-token usage', () => {
    const cost = estimateCost(
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      pricing,
    );
    expect(cost.totalCost).toBe(0);
  });

  it('handles missing pricing fields gracefully (undefined -> 0 rate)', () => {
    const cost = estimateCost(
      {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {}, // no pricing configured
    );
    expect(cost.totalCost).toBe(0);
    expect(cost.inputCost).toBe(0);
  });
});

describe('sumUsage', () => {
  it('accumulates token counts across multiple turns', () => {
    const total = sumUsage([
      {
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
        cacheReadTokens: 800,
        cacheCreationTokens: 100,
      },
      {
        promptTokens: 500,
        completionTokens: 100,
        totalTokens: 600,
        cacheReadTokens: 300,
        cacheCreationTokens: 50,
      },
    ]);
    expect(total).toEqual({
      promptTokens: 1500,
      completionTokens: 300,
      totalTokens: 1800,
      cacheReadTokens: 1100,
      cacheCreationTokens: 150,
    });
  });

  it('returns an all-zero record for an empty list', () => {
    const total = sumUsage([]);
    expect(total).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});
