// Unit tests for sessions.ts model-provider-id handling.
//
// NOTE: a true SQLite integration test (FK ON DELETE SET NULL etc.) is not
// possible in the Node vitest environment - better-sqlite3 is compiled for
// Electron's NODE_MODULE_VERSION, not Node's. Instead we mock getDb() to
// return a controlled fake DB and assert on the SQL + params the store
// issues, plus the rowToSession mapping and the "explicit null clears, omit
// keeps" semantics that are the subtle part of updateSession.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture of every statement the store runs, with its bound params.
interface Stmt {
  sql: string;
  params: unknown;
}

const state = vi.hoisted(() => ({
  stmts: [] as Stmt[],
  // The row returned by the next .get() (single-row reads).
  nextRow: null as Record<string, unknown> | null,
  // The rows returned by the next .all().
  nextRows: [] as Array<Record<string, unknown>>,
}));

// Minimal better-sqlite3 statement/db shim: records SQL + params, returns the
// configured next row(s). sessions.ts uses named params, so each bound call
// passes a single params object as the first argument - record that object.
function makeStmt(sql: string) {
  const record = (arg: unknown): void => {
    // Named-params calls pass one object; positional calls pass primitives.
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
      return state.nextRows;
    },
    run(arg?: unknown) {
      record(arg);
      return { changes: 0 };
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

vi.mock('../../storage/database.js', () => ({
  getDb: () => makeDb(),
}));

vi.mock('../../storage/attachments.js', () => ({
  attachmentsStore: { deleteSessionFiles: () => undefined },
}));

import { sessionsStore } from '../../storage/sessions.js';

beforeEach(() => {
  state.stmts = [];
  state.nextRow = null;
  state.nextRows = [];
});

// Build a session row exactly as the DB stores it (snake_case columns).
function sessionRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 's1',
    title: 't',
    host_id: null,
    host_ids: null,
    safety_mode: 'operator',
    status: 'active',
    model_provider_id: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  };
}

describe('rowToSession mapping', () => {
  it('maps a NULL model_provider_id to undefined', () => {
    state.nextRow = sessionRow({ model_provider_id: null });
    const session = sessionsStore.getSession('s1');
    expect(session?.modelProviderId).toBeUndefined();
  });

  it('maps a non-null model_provider_id to the id', () => {
    state.nextRow = sessionRow({ model_provider_id: 'provider-123' });
    const session = sessionsStore.getSession('s1');
    expect(session?.modelProviderId).toBe('provider-123');
  });
});

describe('createSession INSERT', () => {
  it('defaults model_provider_id to NULL when not provided', () => {
    state.nextRow = sessionRow({ id: 'new' });
    sessionsStore.createSession({
      title: 't',
      hostIds: [],
      safetyMode: 'operator',
      status: 'active',
    });
    const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO sessions'));
    expect(insert).toBeDefined();
    expect(insert!.params).toMatchObject({ modelProviderId: null });
  });

  it('passes an explicit modelProviderId through to the INSERT', () => {
    state.nextRow = sessionRow({ id: 'new' });
    sessionsStore.createSession({
      title: 't',
      hostIds: [],
      safetyMode: 'operator',
      status: 'active',
      modelProviderId: 'p1',
    });
    const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO sessions'));
    expect(insert!.params).toMatchObject({ modelProviderId: 'p1' });
  });
});

describe('updateSession override semantics', () => {
  // existing session used as the "before" state for update merges.
  function existing(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return sessionRow({ id: 's1', model_provider_id: 'existing-override', ...overrides });
  }

  it('sets the override when a string is provided', () => {
    state.nextRow = existing(); // getSession in updateSession
    state.nextRows = [];
    sessionsStore.updateSession('s1', { modelProviderId: 'new-override' });
    const update = state.stmts.find((s) => s.sql.includes('UPDATE sessions'));
    expect(update!.params).toMatchObject({ modelProviderId: 'new-override' });
  });

  it('clears the override when explicit null is provided', () => {
    // null (from "使用默认模型") must set NULL, not fall through to existing.
    state.nextRow = existing({ model_provider_id: 'existing-override' });
    sessionsStore.updateSession('s1', { modelProviderId: null });
    const update = state.stmts.find((s) => s.sql.includes('UPDATE sessions'));
    expect(update!.params).toMatchObject({ modelProviderId: null });
  });

  it('keeps the existing override when the key is omitted', () => {
    // Updating title alone must NOT wipe model_provider_id.
    state.nextRow = existing({ model_provider_id: 'existing-override' });
    sessionsStore.updateSession('s1', { title: 'renamed' });
    const update = state.stmts.find((s) => s.sql.includes('UPDATE sessions'));
    expect(update!.params).toMatchObject({
      modelProviderId: 'existing-override',
      title: 'renamed',
    });
  });
});

describe('getModelProviderId', () => {
  it('returns undefined when the column is NULL', () => {
    state.nextRow = { id: null };
    expect(sessionsStore.getModelProviderId('s1')).toBeUndefined();
  });

  it('returns the id when set', () => {
    state.nextRow = { id: 'provider-456' };
    expect(sessionsStore.getModelProviderId('s1')).toBe('provider-456');
  });

  it('returns undefined when the session does not exist', () => {
    // .get() returns null/undefined when no row matches - simulate the
    // "session not found" case (no row in the DB).
    state.nextRow = null;
    expect(sessionsStore.getModelProviderId('missing')).toBeUndefined();
  });
});
