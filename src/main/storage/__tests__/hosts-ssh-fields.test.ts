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

import { hostsStore, hostAddressChanged } from '../hosts.js';
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
    deviceType: 'linux',
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

    // V3-10: when the host address (host or port) changes, the previously
    // recorded host_key_fingerprint is stale (it belongs to the old endpoint's
    // server key). update() must null it out so the next connect re-runs TOFU
    // instead of failing with "Host denied (verification failed)".
    it('update clears hostKeyFingerprint when the host address changes', () => {
      state.nextRow = hostRow({
        host: '10.0.0.1',
        port: 22,
        host_key_fingerprint: 'SHA256:old',
      });
      hostsStore.update('h1', { host: '10.0.0.2' });
      const upd = state.stmts.find((s) => s.sql.includes('UPDATE hosts'));
      expect(upd!.args).toMatchObject({ hostKeyFingerprint: null });
    });

    it('update clears hostKeyFingerprint when the port changes', () => {
      state.nextRow = hostRow({
        host: '10.0.0.1',
        port: 22,
        host_key_fingerprint: 'SHA256:old',
      });
      hostsStore.update('h1', { port: 2222 });
      const upd = state.stmts.find((s) => s.sql.includes('UPDATE hosts'));
      expect(upd!.args).toMatchObject({ hostKeyFingerprint: null });
    });

    it('update preserves hostKeyFingerprint when host/port are unchanged', () => {
      // Editing only the name (or other non-address field) must NOT clear the
      // fingerprint - the endpoint's server key is still the same.
      state.nextRow = hostRow({
        host: '10.0.0.1',
        port: 22,
        host_key_fingerprint: 'SHA256:old',
      });
      hostsStore.update('h1', { name: 'renamed-host' });
      const upd = state.stmts.find((s) => s.sql.includes('UPDATE hosts'));
      expect(upd!.args).toMatchObject({ hostKeyFingerprint: 'SHA256:old' });
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

    it('clears the fingerprint when passed null (V3-10 clear-host-key UI)', () => {
      // Passing null lets the Settings "清除主机密钥" button reset a stale
      // fingerprint so the next connect re-runs TOFU.
      hostsStore.setHostKeyFingerprint('h1', null);
      const upd = state.stmts.find(
        (s) => s.sql.includes('UPDATE hosts') && s.sql.includes('host_key_fingerprint'),
      );
      expect(upd).toBeDefined();
      expect(upd!.args).toBeNull();
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

  // ── Phase 2: device_type column ──────────────────────────────────────
  describe('Phase 2 device_type field', () => {
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
        device_type: 'linux',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      };
    });

    it('create binds device_type and includes it in the INSERT columns', () => {
      hostsStore.create(baseInput({ deviceType: 'huawei-vrp' }));
      const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO hosts'));
      expect(insert!.sql).toContain('device_type');
      expect(insert!.args).toMatchObject({ deviceType: 'huawei-vrp' });
    });

    it('create defaults deviceType to linux when not set', () => {
      hostsStore.create(baseInput({ deviceType: undefined }));
      const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO hosts'));
      expect(insert!.args).toMatchObject({ deviceType: 'linux' });
    });

    it('update sets device_type', () => {
      hostsStore.update('h1', { deviceType: 'cisco-ios' });
      const upd = state.stmts.find((s) => s.sql.includes('UPDATE hosts'));
      expect(upd!.sql).toContain('device_type');
      expect(upd!.args).toMatchObject({ deviceType: 'cisco-ios' });
    });

    it('rowToConfig maps device_type -> deviceType', () => {
      state.nextRow = { ...state.nextRow!, device_type: 'h3c' };
      const host = hostsStore.get('h1');
      expect(host?.deviceType).toBe('h3c');
    });

    it('rowToConfig defaults deviceType to linux when the column is missing (migrated row)', () => {
      const { device_type: _drop, ...rowWithoutDeviceType } = state.nextRow!;
      state.nextRow = rowWithoutDeviceType;
      const host = hostsStore.get('h1');
      expect(host?.deviceType).toBe('linux');
    });
  });
});

// V3-10: pure helper that drives update()'s "clear fingerprint on address
// change" behavior. Tested directly so the logic is pinned independent of the
// fake-DB shim.
describe('hostAddressChanged', () => {
  const existing = { host: '10.0.0.1', port: 22 };

  it('returns true when host changes', () => {
    expect(hostAddressChanged(existing, { host: '10.0.0.2' })).toBe(true);
  });

  it('returns true when port changes', () => {
    expect(hostAddressChanged(existing, { port: 2222 })).toBe(true);
  });

  it('returns true when both change', () => {
    expect(hostAddressChanged(existing, { host: '10.0.0.2', port: 2222 })).toBe(true);
  });

  it('returns false when neither host nor port is in the payload', () => {
    // A name-only edit (or any payload without host/port) must not clear the
    // fingerprint. Represented here as an empty payload since the helper's
    // payload type only exposes host/port.
    expect(hostAddressChanged(existing, {})).toBe(false);
  });

  it('returns false when host and port are the same as existing', () => {
    expect(hostAddressChanged(existing, { host: '10.0.0.1', port: 22 })).toBe(false);
  });

  it('returns false when only the host is the same (port omitted)', () => {
    expect(hostAddressChanged(existing, { host: '10.0.0.1' })).toBe(false);
  });
});
