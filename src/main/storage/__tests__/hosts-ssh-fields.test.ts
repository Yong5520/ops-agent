// Unit tests for V3-09 SSH fields on the hosts table
// (jump_host_id / agent_forward / host_key_fingerprint).
//
// Same fake-DB shim pattern as hosts-groups.test.ts: better-sqlite3 is compiled
// for Electron's NODE_MODULE_VERSION so true SQLite integration isn't possible
// in vitest. We assert on the SQL + bound params the store issues + the
// rowToConfig mapping.
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Stmt {
  sql: string;
  args: unknown; // single bound-params object (named @args) or positional value
}

const state = vi.hoisted(() => ({
  stmts: [] as Stmt[],
  // The row returned by the next .get().
  nextRow: null as Record<string, unknown> | null,
}));

function makeStmt(sql: string) {
  // hosts.ts calls .get(namedObj) / .run(namedObj) with a single bound-params
  // object (named @args). Record that object directly so tests can matchObject
  // on it. For positional calls (.get(id)), record the raw arg.
  const record = (arg: unknown): void => {
    const params = arg && typeof arg === 'object' && !Array.isArray(arg) ? arg : arg;
    state.stmts.push({ sql, args: params as unknown });
  };
  return {
    get: (arg?: unknown) => {
      record(arg);
      return state.nextRow;
    },
    all: (arg?: unknown) => {
      record(arg);
      return [];
    },
    run: (arg?: unknown) => {
      record(arg);
      return { changes: 1 };
    },
  };
}

function makeDb() {
  return {
    prepare: (sql: string) => makeStmt(sql),
    transaction:
      <T>(fn: () => T) =>
      () =>
        fn(),
    exec: () => undefined,
  };
}

vi.mock('../database.js', () => ({ getDb: () => makeDb() }));
vi.mock('../crypto.js', () => ({ encrypt: (v: string) => v, decrypt: (v: string) => v }));

import { hostsStore } from '../hosts.js';
import type { HostInput } from '../../../shared/types.js';

beforeEach(() => {
  state.stmts = [];
  state.nextRow = null;
});

function baseInput(overrides: Partial<HostInput> = {}): HostInput {
  return {
    name: 'web-1',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'secret',
    groupName: 'default',
    timeoutMs: 60000,
    agentForward: false,
    ...overrides,
  };
}

describe('V3-09 hosts SSH fields', () => {
  // A full host row for create()'s RETURNING * to map back via rowToConfig.
  const hostRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'h1',
    name: 'web-1',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    auth_type: 'password',
    password: null,
    key_path: null,
    sudo_password: null,
    su_password: null,
    group_name: 'default',
    timeout_ms: 60000,
    jump_host_id: null,
    agent_forward: 0,
    host_key_fingerprint: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  });

  describe('create', () => {
    beforeEach(() => {
      // create() does INSERT ... RETURNING * -> rowToConfig(row). The fake
      // .get() returns state.nextRow, so it must be a valid row object.
      state.nextRow = hostRow();
    });

    it('INSERT includes jump_host_id / agent_forward / host_key_fingerprint columns', () => {
      hostsStore.create(
        baseInput({
          jumpHostId: 'bastion-1',
          agentForward: true,
          hostKeyFingerprint: 'sha256-abc',
        }),
      );
      const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO hosts'));
      expect(insert).toBeDefined();
      expect(insert!.sql).toContain('jump_host_id');
      expect(insert!.sql).toContain('agent_forward');
      expect(insert!.sql).toContain('host_key_fingerprint');
      // Bound values are passed via the named-arg object.
      expect(insert!.args).toMatchObject({
        jumpHostId: 'bastion-1',
        agentForward: 1,
        hostKeyFingerprint: 'sha256-abc',
      });
    });

    it('defaults agentForward to 0 (false) when not set', () => {
      hostsStore.create(baseInput());
      const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO hosts'));
      expect(insert!.args).toMatchObject({ agentForward: 0 });
    });

    it('nulls jumpHostId / hostKeyFingerprint when absent', () => {
      hostsStore.create(baseInput());
      const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO hosts'));
      expect(insert!.args).toMatchObject({ jumpHostId: null, hostKeyFingerprint: null });
    });
  });

  describe('update', () => {
    it('UPDATE sets the three SSH columns', () => {
      // update() reads existing first (get -> nextRow), then UPDATE.
      state.nextRow = {
        id: 'h1',
        name: 'web-1',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        auth_type: 'password',
        password: 'secret',
        key_path: null,
        sudo_password: null,
        su_password: null,
        group_name: 'default',
        timeout_ms: 60000,
        jump_host_id: null,
        agent_forward: 0,
        host_key_fingerprint: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      };
      hostsStore.update('h1', { jumpHostId: 'bastion-1', agentForward: true });
      const upd = state.stmts.find((s) => s.sql.includes('UPDATE hosts'));
      expect(upd).toBeDefined();
      expect(upd!.sql).toContain('jump_host_id');
      expect(upd!.sql).toContain('agent_forward');
      expect(upd!.sql).toContain('host_key_fingerprint');
      expect(upd!.args).toMatchObject({ jumpHostId: 'bastion-1', agentForward: 1 });
    });
  });

  describe('rowToConfig mapping', () => {
    it('maps jump_host_id / agent_forward / host_key_fingerprint to camelCase fields', () => {
      state.nextRow = {
        id: 'h1',
        name: 'web-1',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        auth_type: 'password',
        password: null,
        key_path: null,
        sudo_password: null,
        su_password: null,
        group_name: 'default',
        timeout_ms: 60000,
        jump_host_id: 'bastion-1',
        agent_forward: 1,
        host_key_fingerprint: 'sha256-abc',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      };
      const host = hostsStore.get('h1');
      expect(host).toMatchObject({
        jumpHostId: 'bastion-1',
        agentForward: true,
        hostKeyFingerprint: 'sha256-abc',
      });
    });

    it('defaults agentForward to false when the DB value is 0', () => {
      state.nextRow = {
        id: 'h1',
        name: 'web-1',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        auth_type: 'password',
        password: null,
        key_path: null,
        sudo_password: null,
        su_password: null,
        group_name: 'default',
        timeout_ms: 60000,
        jump_host_id: null,
        agent_forward: 0,
        host_key_fingerprint: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      };
      const host = hostsStore.get('h1');
      expect(host?.agentForward).toBe(false);
      expect(host?.jumpHostId).toBeUndefined();
      expect(host?.hostKeyFingerprint).toBeUndefined();
    });
  });

  describe('setHostKeyFingerprint (V3-09 TOFU, review C1 fix)', () => {
    it('issues a targeted UPDATE on ONLY the host_key_fingerprint column', () => {
      hostsStore.setHostKeyFingerprint('h1', 'SHA256:captured');
      const upd = state.stmts.find(
        (s) => s.sql.includes('UPDATE hosts') && s.sql.includes('host_key_fingerprint'),
      );
      expect(upd).toBeDefined();
      // Must NOT touch password / sudo_password / su_password columns - the
      // old update()-merge path nulled them (C1 bug). This targeted UPDATE
      // sets only the fingerprint.
      expect(upd!.sql).not.toContain('password');
      expect(upd!.sql).not.toContain('key_path');
      // The targeted UPDATE runs .run(fingerprint, id) positionally; the shim
      // records the first positional arg.
      expect(upd!.args).toBe('SHA256:captured');
    });
  });

  // ── V3-09.1: encoded-bastion columns ──────────────────────────────────
  describe('V3-09.1 encoded-bastion fields', () => {
    beforeEach(() => {
      state.nextRow = {
        id: 'h1',
        name: 'web-1',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        auth_type: 'password',
        password: null,
        key_path: null,
        sudo_password: null,
        su_password: null,
        group_name: 'default',
        timeout_ms: 60000,
        jump_host_id: null,
        agent_forward: 0,
        host_key_fingerprint: null,
        jump_mode: 'forward',
        jump_username_template: null,
        jump_target_auth: 'bastion-managed',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      };
    });

    it('create binds jump_mode / jump_username_template / jump_target_auth', () => {
      hostsStore.create(
        baseInput({
          jumpMode: 'encoded',
          jumpUsernameTemplate: '{targetUser}@{targetHost}',
          jumpTargetAuth: 'password',
        }),
      );
      const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO hosts'));
      expect(insert!.sql).toContain('jump_mode');
      expect(insert!.sql).toContain('jump_username_template');
      expect(insert!.sql).toContain('jump_target_auth');
      expect(insert!.args).toMatchObject({
        jumpMode: 'encoded',
        jumpUsernameTemplate: '{targetUser}@{targetHost}',
        jumpTargetAuth: 'password',
      });
    });

    it('create defaults jump_mode=forward and jump_target_auth=bastion-managed', () => {
      hostsStore.create(baseInput());
      const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO hosts'));
      expect(insert!.args).toMatchObject({
        jumpMode: 'forward',
        jumpTargetAuth: 'bastion-managed',
      });
    });

    it('update sets the encoded-bastion columns', () => {
      hostsStore.update('h1', { jumpMode: 'encoded', jumpTargetAuth: 'password' });
      const upd = state.stmts.find((s) => s.sql.includes('UPDATE hosts'));
      expect(upd!.sql).toContain('jump_mode');
      expect(upd!.sql).toContain('jump_target_auth');
      expect(upd!.args).toMatchObject({ jumpMode: 'encoded', jumpTargetAuth: 'password' });
    });

    it('rowToConfig maps jump_mode / jump_target_auth with defaults', () => {
      const host = hostsStore.get('h1');
      expect(host?.jumpMode).toBe('forward');
      expect(host?.jumpTargetAuth).toBe('bastion-managed');
      expect(host?.jumpUsernameTemplate).toBeUndefined();
    });
  });
});
