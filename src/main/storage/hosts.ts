import { getDb } from './database.js';
import { encrypt, decrypt } from './crypto.js';
import { validateSerialHost } from '../serial/serial-options.js';
import type { HostConfig, HostInput, DeviceType, ConnectionType } from '../../shared/types.js';

/**
 * V3-10: returns true when an update payload changes the host's network
 * address (host or port) relative to the existing record. When the address
 * changes, the stored host_key_fingerprint is stale - it belongs to the old
 * endpoint's server key - so update() must clear it and let the next connect
 * re-run TOFU. Pure + exported for direct unit testing.
 */
export function hostAddressChanged(
  existing: { host: string; port: number },
  payload: { host?: string; port?: number },
): boolean {
  return (
    (payload.host !== undefined && payload.host !== existing.host) ||
    (payload.port !== undefined && payload.port !== existing.port)
  );
}

interface HostRow {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: string;
  password: string | null;
  key_path: string | null;
  sudo_password: string | null;
  su_password: string | null;
  group_name: string;
  timeout_ms: number;
  jump_host_id: string | null;
  agent_forward: number;
  host_key_fingerprint: string | null;
  jump_mode: string | null;
  jump_username_template: string | null;
  jump_target_auth: string | null;
  device_type: string;
  connection_type: string;
  serial_port: string | null;
  baud_rate: number | null;
  data_bits: number | null;
  stop_bits: number | null;
  parity: string | null;
  flow_control: string | null;
  login_required: number;
  created_at: string;
  updated_at: string;
}

function rowToConfig(row: HostRow, includeSecrets = false): HostConfig {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type as 'password' | 'key',
    password: includeSecrets && row.password ? decrypt(row.password) : undefined,
    keyPath: row.key_path ?? undefined,
    sudoPassword: includeSecrets && row.sudo_password ? decrypt(row.sudo_password) : undefined,
    suPassword: includeSecrets && row.su_password ? decrypt(row.su_password) : undefined,
    groupName: row.group_name,
    timeoutMs: row.timeout_ms,
    jumpHostId: row.jump_host_id ?? undefined,
    agentForward: row.agent_forward === 1,
    hostKeyFingerprint: row.host_key_fingerprint ?? undefined,
    // V3-09.1: encoded-bastion fields. DB defaults guarantee non-null for
    // jump_mode/jump_target_auth, but older rows migrated via addColumnIfNotExists
    // may carry NULL -> fall back to the documented defaults.
    jumpMode: (row.jump_mode ?? 'forward') as 'forward' | 'encoded',
    jumpUsernameTemplate: row.jump_username_template ?? undefined,
    jumpTargetAuth: (row.jump_target_auth ?? 'bastion-managed') as 'bastion-managed' | 'password',
    deviceType: (row.device_type ?? 'linux') as DeviceType,
    // Serial console fields (v17). Migrated rows lack the columns -> default
    // to a plain SSH host.
    connectionType: (row.connection_type ?? 'ssh') as ConnectionType,
    serialPort: row.serial_port ?? undefined,
    baudRate: row.baud_rate ?? undefined,
    dataBits: (row.data_bits ?? undefined) as 7 | 8 | undefined,
    stopBits: (row.stop_bits ?? undefined) as 1 | 2 | undefined,
    parity: (row.parity ?? undefined) as HostConfig['parity'],
    flowControl: (row.flow_control ?? undefined) as HostConfig['flowControl'],
    loginRequired: row.login_required === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const hostsStore = {
  list(): HostConfig[] {
    const rows = getDb().prepare('SELECT * FROM hosts ORDER BY name ASC').all() as HostRow[];
    return rows.map((r) => rowToConfig(r));
  },

  get(id: string): HostConfig | null {
    const row = getDb().prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
    return row ? rowToConfig(row) : null;
  },

  // Returns host with decrypted secrets. Use only in main process for SSH layer.
  getWithSecrets(id: string): HostConfig | null {
    const row = getDb().prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
    return row ? rowToConfig(row, true) : null;
  },

  create(payload: HostInput): HostConfig {
    const connectionType = payload.connectionType ?? 'ssh';
    if (connectionType === 'serial') {
      const serialError = validateSerialHost(payload);
      if (serialError) {
        throw new Error(serialError);
      }
    } else {
      if (payload.authType === 'password' && !payload.password) {
        throw new Error('密码认证方式需要填写密码');
      }
      if (payload.authType === 'key' && !payload.keyPath) {
        throw new Error('密钥认证方式需要填写密钥文件路径');
      }
    }
    const isSerial = connectionType === 'serial';
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO hosts (name, host, port, username, auth_type, password, key_path,
                         sudo_password, su_password, group_name, timeout_ms,
                         jump_host_id, agent_forward, host_key_fingerprint,
                         jump_mode, jump_username_template, jump_target_auth,
                         device_type,
                         connection_type, serial_port, baud_rate, data_bits,
                         stop_bits, parity, flow_control, login_required)
      VALUES (@name, @host, @port, @username, @authType, @password, @keyPath,
              @sudoPassword, @suPassword, @groupName, @timeoutMs,
              @jumpHostId, @agentForward, @hostKeyFingerprint,
              @jumpMode, @jumpUsernameTemplate, @jumpTargetAuth,
              @deviceType,
              @connectionType, @serialPort, @baudRate, @dataBits,
              @stopBits, @parity, @flowControl, @loginRequired)
      RETURNING *
    `);
    const row = stmt.get({
      name: payload.name,
      // Serial hosts have no network address: mirror the port path into `host`
      // so NOT NULL holds and audit logs / terminal titles show a meaningful
      // "address" (e.g. COM3).
      host: isSerial ? payload.serialPort!.trim() : payload.host,
      port: payload.port,
      username: payload.username,
      authType: payload.authType,
      password: payload.password ? encrypt(payload.password) : null,
      keyPath: payload.keyPath ?? null,
      sudoPassword: payload.sudoPassword ? encrypt(payload.sudoPassword) : null,
      suPassword: payload.suPassword ? encrypt(payload.suPassword) : null,
      groupName: payload.groupName,
      timeoutMs: payload.timeoutMs,
      jumpHostId: payload.jumpHostId ?? null,
      agentForward: payload.agentForward ? 1 : 0,
      hostKeyFingerprint: payload.hostKeyFingerprint ?? null,
      jumpMode: payload.jumpMode ?? 'forward',
      jumpUsernameTemplate: payload.jumpUsernameTemplate ?? null,
      jumpTargetAuth: payload.jumpTargetAuth ?? 'bastion-managed',
      deviceType: payload.deviceType ?? 'linux',
      // Serial console fields: resolved defaults (8N1, no flow control) are
      // persisted so a later default change never alters existing hosts.
      connectionType,
      serialPort: isSerial ? payload.serialPort!.trim() : null,
      baudRate: isSerial ? (payload.baudRate ?? 9600) : null,
      dataBits: isSerial ? (payload.dataBits ?? 8) : null,
      stopBits: isSerial ? (payload.stopBits ?? 1) : null,
      parity: isSerial ? (payload.parity ?? 'none') : null,
      flowControl: isSerial ? (payload.flowControl ?? 'none') : null,
      loginRequired: isSerial && payload.loginRequired ? 1 : 0,
    }) as HostRow;
    return rowToConfig(row);
  },

  update(id: string, payload: Partial<HostInput>): HostConfig {
    const db = getDb();
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Host not found: ${id}`);
    }
    const connectionType = payload.connectionType ?? existing.connectionType ?? 'ssh';
    const serialPort = payload.serialPort ?? existing.serialPort;
    const baudRate = payload.baudRate ?? existing.baudRate;
    const dataBits = payload.dataBits ?? existing.dataBits;
    const stopBits = payload.stopBits ?? existing.stopBits;
    const parity = payload.parity ?? existing.parity;
    const flowControl = payload.flowControl ?? existing.flowControl;
    const loginRequired = payload.loginRequired ?? existing.loginRequired ?? false;
    if (connectionType === 'serial') {
      // Validate the merged serial settings (not just the payload slice) so a
      // partial update can't leave the record invalid. Credentials come from
      // getWithSecrets: this.get() never decrypts the stored password, so a
      // login-enabled host could never pass an edit that omits the password.
      const existingSecrets = this.getWithSecrets(id) ?? existing;
      const serialError = validateSerialHost({
        serialPort,
        baudRate,
        dataBits,
        stopBits,
        parity,
        flowControl,
        loginRequired,
        username: payload.username ?? existingSecrets.username,
        password: payload.password ?? existingSecrets.password,
      });
      if (serialError) {
        throw new Error(serialError);
      }
    }
    const isSerial = connectionType === 'serial';
    const merged: HostInput = {
      name: payload.name ?? existing.name,
      // Serial hosts mirror the port path into `host` (their display address).
      host: isSerial ? serialPort!.trim() : (payload.host ?? existing.host),
      port: payload.port ?? existing.port,
      username: payload.username ?? existing.username,
      authType: payload.authType ?? existing.authType,
      password: payload.password ?? existing.password,
      keyPath: payload.keyPath ?? existing.keyPath,
      sudoPassword: payload.sudoPassword ?? existing.sudoPassword,
      suPassword: payload.suPassword ?? existing.suPassword,
      groupName: payload.groupName ?? existing.groupName,
      timeoutMs: payload.timeoutMs ?? existing.timeoutMs,
      jumpHostId: payload.jumpHostId ?? existing.jumpHostId,
      agentForward: payload.agentForward ?? existing.agentForward,
      // V3-10: if the host address (host or port) changed, the previously
      // recorded fingerprint belongs to the old endpoint's server key and is
      // now stale - null it out so the next connect re-runs TOFU instead of
      // hard-failing with "Host denied (verification failed)". When the address
      // is unchanged, preserve the fingerprint (explicit payload value wins,
      // else the existing one).
      hostKeyFingerprint: hostAddressChanged(existing, payload)
        ? undefined
        : (payload.hostKeyFingerprint ?? existing.hostKeyFingerprint),
      jumpMode: payload.jumpMode ?? existing.jumpMode ?? 'forward',
      jumpUsernameTemplate: payload.jumpUsernameTemplate ?? existing.jumpUsernameTemplate,
      jumpTargetAuth: payload.jumpTargetAuth ?? existing.jumpTargetAuth ?? 'bastion-managed',
      deviceType: payload.deviceType ?? existing.deviceType ?? 'linux',
      connectionType,
      serialPort,
      baudRate,
      dataBits,
      stopBits,
      parity,
      flowControl,
      loginRequired,
    };
    db.prepare(
      `
      UPDATE hosts
      SET name = @name, host = @host, port = @port, username = @username,
          auth_type = @authType, password = @password, key_path = @keyPath,
          sudo_password = @sudoPassword, su_password = @suPassword,
          group_name = @groupName, timeout_ms = @timeoutMs,
          jump_host_id = @jumpHostId, agent_forward = @agentForward,
          host_key_fingerprint = @hostKeyFingerprint,
          jump_mode = @jumpMode, jump_username_template = @jumpUsernameTemplate,
          jump_target_auth = @jumpTargetAuth,
          device_type = @deviceType,
          connection_type = @connectionType, serial_port = @serialPort,
          baud_rate = @baudRate, data_bits = @dataBits, stop_bits = @stopBits,
          parity = @parity, flow_control = @flowControl,
          login_required = @loginRequired,
          updated_at = datetime('now')
      WHERE id = @id
    `,
    ).run({
      id,
      name: merged.name,
      host: merged.host,
      port: merged.port,
      username: merged.username,
      authType: merged.authType,
      password: merged.password ? encrypt(merged.password) : null,
      keyPath: merged.keyPath ?? null,
      sudoPassword: merged.sudoPassword ? encrypt(merged.sudoPassword) : null,
      suPassword: merged.suPassword ? encrypt(merged.suPassword) : null,
      groupName: merged.groupName,
      timeoutMs: merged.timeoutMs,
      jumpHostId: merged.jumpHostId ?? null,
      agentForward: merged.agentForward ? 1 : 0,
      hostKeyFingerprint: merged.hostKeyFingerprint ?? null,
      jumpMode: merged.jumpMode,
      jumpUsernameTemplate: merged.jumpUsernameTemplate ?? null,
      jumpTargetAuth: merged.jumpTargetAuth,
      deviceType: merged.deviceType,
      connectionType: merged.connectionType ?? 'ssh',
      serialPort: isSerial ? (merged.serialPort ?? null) : null,
      baudRate: isSerial ? (merged.baudRate ?? 9600) : null,
      dataBits: isSerial ? (merged.dataBits ?? 8) : null,
      stopBits: isSerial ? (merged.stopBits ?? 1) : null,
      parity: isSerial ? (merged.parity ?? 'none') : null,
      flowControl: isSerial ? (merged.flowControl ?? 'none') : null,
      loginRequired: isSerial && merged.loginRequired ? 1 : 0,
    });
    return this.get(id)!;
  },

  // V3-09: persist a captured host-key fingerprint WITHOUT round-tripping
  // through update(). update() merges via this.get() (no secrets), which would
  // null out password/sudoPassword/suPassword. This targeted UPDATE touches only
  // the fingerprint column so credentials survive. Used by the pool's TOFU path.
  // V3-10: fingerprint is nullable - passing null clears the stored fingerprint
  // (used by the Settings "清除主机密钥" button to recover from a stale record).
  setHostKeyFingerprint(id: string, fingerprint: string | null): void {
    getDb()
      .prepare(
        `UPDATE hosts SET host_key_fingerprint = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(fingerprint, id);
  },

  delete(id: string): void {
    // Delete in a transaction. Multiple tables reference hosts(id) via
    // foreign key but lack ON DELETE SET NULL/CASCADE (legacy schema).
    // We preserve audit/tool-call history by nulling host_id rather than
    // deleting rows. host_name/host_ip in audit_logs are plain TEXT so the
    // audit trail remains readable. Custom rules are host-specific → delete.
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare('UPDATE sessions SET host_id = NULL WHERE host_id = ?').run(id);
      db.prepare('UPDATE tool_calls SET host_id = NULL WHERE host_id = ?').run(id);
      db.prepare('UPDATE audit_logs SET host_id = NULL WHERE host_id = ?').run(id);
      // V3-09: clear bastion references to the deleted host so dependents
      // don't dangle (would throw "Unknown host id" on their next connect).
      db.prepare('UPDATE hosts SET jump_host_id = NULL WHERE jump_host_id = ?').run(id);
      db.prepare('DELETE FROM custom_rules WHERE host_id = ?').run(id);
      db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
    });
    tx();
  },

  getByName(name: string): HostConfig | null {
    const row = getDb().prepare('SELECT * FROM hosts WHERE name = ?').get(name) as
      HostRow | undefined;
    return row ? rowToConfig(row) : null;
  },

  // Batch create multiple hosts in a single transaction.
  // Returns { created, errors } where errors contains per-row failure info.
  // On any DB constraint violation, only that row is skipped - others proceed.
  batchCreate(payloads: HostInput[]): {
    created: HostConfig[];
    errors: Array<{ row: number; name: string; error: string }>;
  } {
    const created: HostConfig[] = [];
    const errors: Array<{ row: number; name: string; error: string }> = [];

    for (let i = 0; i < payloads.length; i++) {
      const payload = payloads[i];
      try {
        const host = this.create(payload);
        created.push(host);
      } catch (err) {
        errors.push({
          row: i,
          name: payload.name ?? `(row ${i})`,
          error: (err as Error).message,
        });
      }
    }
    return { created, errors };
  },

  // Create a new (possibly empty) host group/folder. Stored in host_groups so
  // it persists even with zero hosts. Idempotent (INSERT OR IGNORE). Trims and
  // rejects empty names. Returns the created group name.
  createGroup(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('文件夹名称不能为空');
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO host_groups (name) VALUES (?)').run(trimmed);
    return trimmed;
  },

  // Rename a host group: move all hosts with oldName to newName, and update
  // the host_groups row (drop old, insert new - idempotent if newName exists).
  renameGroup(oldName: string, newName: string): number {
    const db = getDb();
    const rename = db.transaction(() => {
      const result = db
        .prepare(
          "UPDATE hosts SET group_name = ?, updated_at = datetime('now') WHERE group_name = ?",
        )
        .run(newName, oldName);
      db.prepare('DELETE FROM host_groups WHERE name = ?').run(oldName);
      db.prepare('INSERT OR IGNORE INTO host_groups (name) VALUES (?)').run(newName);
      return result.changes;
    });
    return rename();
  },

  // Delete a host group: move all hosts in the group to 'default' and remove
  // the host_groups row so the (now-empty) folder disappears.
  deleteGroup(groupName: string): number {
    if (groupName === 'default') return 0; // Cannot delete default group
    const db = getDb();
    const result = db
      .prepare(
        "UPDATE hosts SET group_name = 'default', updated_at = datetime('now') WHERE group_name = ?",
      )
      .run(groupName);
    db.prepare('DELETE FROM host_groups WHERE name = ?').run(groupName);
    return result.changes;
  },

  // List all group names: union explicitly-created host_groups folders (which
  // may be empty) with distinct group_name values from hosts (which always
  // includes 'default' once any host exists).
  listGroups(): string[] {
    const rows = getDb()
      .prepare(
        `SELECT name FROM (
          SELECT name FROM host_groups
          UNION
          SELECT DISTINCT group_name AS name FROM hosts WHERE group_name IS NOT NULL
        ) ORDER BY name ASC`,
      )
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  },
};
