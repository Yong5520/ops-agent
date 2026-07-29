// Unit tests for host group (folder) management in hosts.ts.
//
// NOTE: a true SQLite integration test is not possible in the vitest
// environment (better-sqlite3 is compiled for Electron's NODE_MODULE_VERSION).
// We mock getDb() with a fake DB that records every statement + bound args,
// and assert on the SQL/params the store issues.
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Stmt {
  sql: string;
  args: unknown[];
}

const state = vi.hoisted(() => ({
  stmts: [] as Stmt[],
  nextRows: [] as Array<Record<string, unknown>>,
  nextRow: null as Record<string, unknown> | null,
  runChanges: 0,
}));

function makeStmt(sql: string) {
  return {
    get: (...args: unknown[]) => {
      state.stmts.push({ sql, args });
      return state.nextRow;
    },
    all: (...args: unknown[]) => {
      state.stmts.push({ sql, args });
      return state.nextRows;
    },
    run: (...args: unknown[]) => {
      state.stmts.push({ sql, args });
      return { changes: state.runChanges };
    },
  };
}

function makeDb() {
  return {
    prepare: (sql: string) => makeStmt(sql),
    transaction: <T>(fn: () => T) => () => fn(),
    exec: () => undefined,
  };
}

vi.mock('../database.js', () => ({ getDb: () => makeDb() }));
vi.mock('../crypto.js', () => ({ encrypt: (v: string) => v, decrypt: (v: string) => v }));

import { hostsStore } from '../hosts.js';

beforeEach(() => {
  state.stmts = [];
  state.nextRows = [];
  state.nextRow = null;
  state.runChanges = 0;
});

describe('host groups (folders)', () => {
  it('createGroup inserts into host_groups and trims the name', () => {
    const name = hostsStore.createGroup('  web-servers  ');
    expect(name).toBe('web-servers');
    const insert = state.stmts.find((s) => s.sql.includes('INSERT OR IGNORE INTO host_groups'));
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain('web-servers');
  });

  it('createGroup rejects empty/whitespace names', () => {
    expect(() => hostsStore.createGroup('   ')).toThrow();
    expect(() => hostsStore.createGroup('')).toThrow();
    expect(state.stmts.some((s) => s.sql.includes('host_groups'))).toBe(false);
  });

  it('listGroups unions host_groups with distinct host group_name', () => {
    state.nextRows = [{ name: 'default' }, { name: 'web' }, { name: 'db' }];
    const groups = hostsStore.listGroups();
    expect(groups).toEqual(['default', 'web', 'db']);
    const q = state.stmts.find(
      (s) => s.sql.includes('host_groups') && s.sql.toUpperCase().includes('UNION'),
    );
    expect(q).toBeTruthy();
  });

  it('deleteGroup refuses to delete the default group', () => {
    const n = hostsStore.deleteGroup('default');
    expect(n).toBe(0);
    expect(state.stmts.some((s) => s.sql.toUpperCase().includes('DELETE'))).toBe(false);
  });

  it('deleteGroup moves hosts to default and removes the host_groups row', () => {
    state.runChanges = 3;
    const n = hostsStore.deleteGroup('web');
    expect(n).toBe(3);
    expect(
      state.stmts.some((s) => s.sql.includes("group_name = 'default'") && s.args.includes('web')),
    ).toBe(true);
    expect(
      state.stmts.some((s) => s.sql.includes('DELETE FROM host_groups') && s.args.includes('web')),
    ).toBe(true);
  });

  it('renameGroup moves hosts, drops the old host_groups row, inserts the new name', () => {
    state.runChanges = 2;
    const n = hostsStore.renameGroup('web', 'api');
    expect(n).toBe(2);
    expect(
      state.stmts.some((s) => s.sql.includes('UPDATE hosts SET group_name') && s.args.includes('api')),
    ).toBe(true);
    expect(
      state.stmts.some(
        (s) => s.sql.includes('DELETE FROM host_groups') && s.args.includes('web'),
      ),
    ).toBe(true);
    expect(
      state.stmts.some(
        (s) => s.sql.includes('INSERT OR IGNORE INTO host_groups') && s.args.includes('api'),
      ),
    ).toBe(true);
  });
});
