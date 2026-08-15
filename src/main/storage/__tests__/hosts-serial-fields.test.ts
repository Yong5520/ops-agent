// Unit tests for serial-connection fields on the hosts table
// (connection_type / serial_port / baud_rate / data_bits / stop_bits / parity /
//  flow_control / login_required).
//
// Same fake-DB shim pattern as hosts-ssh-fields.test.ts: assert on the SQL +
// bound params the store issues + the rowToConfig mapping + the serial
// validation branch.
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Stmt {
  sql: string;
  args: unknown;
}

const state = vi.hoisted(() => ({
  stmts: [] as Stmt[],
  nextRow: null as Record<string, unknown> | null,
}));

function makeStmt(sql: string) {
  const record = (arg: unknown): void => {
    state.stmts.push({ sql, args: arg });
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
vi.mock('../crypto.js', () => ({
  encrypt: (v: string) => v,
  decrypt: (v: string) => v,
}));

import { hostsStore } from '../hosts.js';
import type { HostInput } from '../../../shared/types.js';

beforeEach(() => {
  state.stmts = [];
  state.nextRow = null;
});

function serialInput(overrides: Partial<HostInput> = {}): HostInput {
  return {
    name: 'switch-init',
    host: 'COM3',
    port: 22,
    username: '',
    authType: 'password',
    groupName: 'default',
    timeoutMs: 60000,
    agentForward: false,
    deviceType: 'generic',
    connectionType: 'serial',
    serialPort: 'COM3',
    baudRate: 9600,
    loginRequired: false,
    ...overrides,
  };
}

// A full serial host row for create()'s RETURNING * / rowToConfig.
const serialRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'h1',
  name: 'switch-init',
  host: 'COM3',
  port: 22,
  username: '',
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
  device_type: 'generic',
  connection_type: 'serial',
  serial_port: 'COM3',
  baud_rate: 9600,
  data_bits: 8,
  stop_bits: 1,
  parity: 'none',
  flow_control: 'none',
  login_required: 0,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  ...overrides,
});

describe('hosts serial fields', () => {
  describe('create', () => {
    it('INSERT includes the 8 serial columns', () => {
      state.nextRow = serialRow();
      hostsStore.create(serialInput());
      const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO hosts'));
      expect(insert).toBeDefined();
      expect(insert!.sql).toContain('connection_type');
      expect(insert!.sql).toContain('serial_port');
      expect(insert!.sql).toContain('baud_rate');
      expect(insert!.sql).toContain('data_bits');
      expect(insert!.sql).toContain('stop_bits');
      expect(insert!.sql).toContain('parity');
      expect(insert!.sql).toContain('flow_control');
      expect(insert!.sql).toContain('login_required');
      expect(insert!.args).toMatchObject({
        connectionType: 'serial',
        serialPort: 'COM3',
        baudRate: 9600,
        loginRequired: 0,
      });
    });

    it('defaults 8N1 + no flow control when advanced params are omitted', () => {
      state.nextRow = serialRow();
      hostsStore.create(
        serialInput({
          dataBits: undefined,
          stopBits: undefined,
          parity: undefined,
          flowControl: undefined,
        }),
      );
      const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO hosts'));
      expect(insert!.args).toMatchObject({
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      });
    });

    it('defaults connection_type to ssh for regular hosts', () => {
      state.nextRow = serialRow({ connection_type: 'ssh', serial_port: null });
      hostsStore.create(
        serialInput({
          connectionType: undefined,
          serialPort: undefined,
          baudRate: undefined,
          loginRequired: undefined,
          password: 'secret',
        }),
      );
      const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO hosts'));
      expect(insert!.args).toMatchObject({ connectionType: 'ssh', serialPort: null });
    });

    it('stores the serial port path in host as the display address', () => {
      state.nextRow = serialRow();
      hostsStore.create(serialInput({ host: '', serialPort: 'COM7' }));
      const insert = state.stmts.find((s) => s.sql.includes('INSERT INTO hosts'));
      // host column mirrors serialPort so audit logs / terminal titles show a
      // meaningful "address" for serial hosts.
      expect(insert!.args).toMatchObject({ host: 'COM7', serialPort: 'COM7' });
    });

    it('rejects a serial host without a serial port', () => {
      expect(() => hostsStore.create(serialInput({ serialPort: undefined, host: '' }))).toThrow(
        /串口/,
      );
    });

    it('rejects a serial host with login enabled but missing credentials', () => {
      expect(() =>
        hostsStore.create(serialInput({ loginRequired: true, username: '', password: undefined })),
      ).toThrow(/用户名/);
    });

    it('does not require an SSH password for serial hosts', () => {
      // authType stays 'password' (column default) but the SSH "password auth
      // requires a password" check must not fire for serial hosts.
      state.nextRow = serialRow();
      expect(() => hostsStore.create(serialInput({ password: undefined }))).not.toThrow();
    });
  });

  describe('update', () => {
    it('UPDATE sets the serial columns', () => {
      state.nextRow = serialRow({ username: 'admin', password: 'secret' });
      hostsStore.update('h1', { baudRate: 115200, loginRequired: true });
      const upd = state.stmts.find((s) => s.sql.includes('UPDATE hosts'));
      expect(upd).toBeDefined();
      expect(upd!.sql).toContain('baud_rate');
      expect(upd!.sql).toContain('login_required');
      expect(upd!.args).toMatchObject({ baudRate: 115200, loginRequired: 1 });
    });

    it('switching to serial mirrors serialPort into host', () => {
      state.nextRow = serialRow({ connection_type: 'ssh', serial_port: null });
      hostsStore.update('h1', { connectionType: 'serial', serialPort: 'COM5' });
      const upd = state.stmts.find((s) => s.sql.includes('UPDATE hosts'));
      expect(upd!.args).toMatchObject({ host: 'COM5', serialPort: 'COM5' });
    });
  });

  describe('rowToConfig mapping', () => {
    it('maps snake_case serial columns to camelCase fields', () => {
      state.nextRow = serialRow({ baud_rate: 115200, login_required: 1, parity: 'even' });
      const host = hostsStore.get('h1');
      expect(host).toMatchObject({
        connectionType: 'serial',
        serialPort: 'COM3',
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'even',
        flowControl: 'none',
        loginRequired: true,
      });
    });

    it('defaults connectionType to ssh when the column is missing (migrated row)', () => {
      const { connection_type: _c, ...rowWithout } = serialRow();
      state.nextRow = rowWithout;
      const host = hostsStore.get('h1');
      expect(host?.connectionType).toBe('ssh');
    });

    it('leaves serial fields undefined for ssh rows', () => {
      state.nextRow = serialRow({ connection_type: 'ssh', serial_port: null, baud_rate: null });
      const host = hostsStore.get('h1');
      expect(host?.connectionType).toBe('ssh');
      expect(host?.serialPort).toBeUndefined();
      expect(host?.baudRate).toBeUndefined();
      expect(host?.loginRequired).toBe(false);
    });
  });
});
