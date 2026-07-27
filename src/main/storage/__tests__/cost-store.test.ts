// Unit tests for session cost persistence (cost-store.ts).
//
// As with sessions-model.test.ts, a true SQLite integration test is impossible
// in the Node vitest environment (better-sqlite3 is compiled for Electron's
// NODE_MODULE_VERSION). We mock getDb() to return a controlled fake DB and
// assert on the SQL + bound params the store issues, plus the accumulation
// logic in getSessionCostTotal.
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Stmt {
  sql: string;
  params: unknown;
}

const state = vi.hoisted(() => ({
  stmts: [] as Stmt[],
  // The scalar/row returned by the next .get().
  nextRow: null as Record<string, unknown> | null,
}));

function makeStmt(sql: string) {
  const record = (arg: unknown): void => {
    state.stmts.push({
      sql,
      params: arg && typeof arg === 'object' && !Array.isArray(arg) ? arg : arg,
    });
  };
  return {
    get(arg?: unknown) {
      record(arg);
      return state.nextRow;
    },
    all(arg?: unknown) {
      record(arg);
      return [];
    },
    run(arg?: unknown) {
      record(arg);
      return { changes: 1 };
    },
  };
}

function makeDb() {
  return {
    prepare: (sql: string) => makeStmt(sql),
    transaction: (fn: () => void) => () => fn(),
    exec: () => undefined,
  };
}

vi.mock('../database.js', () => ({
  getDb: () => makeDb(),
}));

import { recordSessionCost, getSessionCostTotal } from '../cost-store.js';
import type { TokenUsage } from '../../agent/cost-tracking.js';

beforeEach(() => {
  state.stmts = [];
  state.nextRow = null;
});

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

describe('recordSessionCost', () => {
  it('INSERTs a session_costs row with all token fields + estimated USD', () => {
    recordSessionCost('s1', usage({ promptTokens: 1500, completionTokens: 300 }), {
      inputPricePerMTok: 3,
      outputPricePerMTok: 15,
    });

    const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO session_costs'));
    expect(insert).toBeDefined();
    expect(insert!.params).toMatchObject({
      sessionId: 's1',
      promptTokens: 1500,
      completionTokens: 300,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // 1500/1M * 3 + 300/1M * 15 = 0.0045 + 0.0045 = 0.009 (use closeTo for float)
    expect((insert!.params as { estimatedUsd: number }).estimatedUsd).toBeCloseTo(0.009, 6);
  });

  it('stores the model provider id when provided (for per-model attribution)', () => {
    recordSessionCost('s1', usage(), { inputPricePerMTok: 3 }, 'provider-abc');
    const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO session_costs'));
    expect(insert!.params).toMatchObject({ modelProviderId: 'provider-abc' });
  });

  it('records cost even when pricing is absent (estimated_usd = 0, tokens still persisted)', () => {
    // Token accounting must not depend on pricing being configured - we still
    // want the token totals even if the user hasn't entered prices.
    recordSessionCost('s1', usage({ promptTokens: 5000 }), undefined);
    const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO session_costs'));
    expect(insert!.params).toMatchObject({
      promptTokens: 5000,
      estimatedUsd: 0,
    });
  });
});

describe('getSessionCostTotal', () => {
  it('SUMs tokens and estimated_usd across all rows for a session', () => {
    state.nextRow = {
      promptTokens: 3000,
      completionTokens: 600,
      totalTokens: 3600,
      cacheReadTokens: 800,
      cacheCreationTokens: 100,
      estimatedUsd: 0.027,
    };
    const total = getSessionCostTotal('s1');

    const select = state.stmts.find(
      (s) => s.sql.includes('SELECT') && s.sql.includes('FROM session_costs'),
    );
    expect(select).toBeDefined();
    // getSessionCostTotal uses a positional ? param, so the bound arg is the
    // raw string 's1' (not an array) - matches the shim's positional-call recording.
    expect(select!.params).toBe('s1');
    expect(total).toEqual({
      promptTokens: 3000,
      completionTokens: 600,
      totalTokens: 3600,
      cacheReadTokens: 800,
      cacheCreationTokens: 100,
      estimatedUsd: 0.027,
    });
  });

  it('returns an all-zero total when the session has no cost rows', () => {
    state.nextRow = null;
    const total = getSessionCostTotal('empty-session');
    expect(total).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedUsd: 0,
    });
  });
});
