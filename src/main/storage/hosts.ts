import { getDb } from './database.js';
import { encrypt, decrypt } from './crypto.js';
import type { HostConfig, HostInput } from '../../shared/types.js';

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
    if (payload.authType === 'password' && !payload.password) {
      throw new Error('密码认证方式需要填写密码');
    }
    if (payload.authType === 'key' && !payload.keyPath) {
      throw new Error('密钥认证方式需要填写密钥文件路径');
    }
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO hosts (name, host, port, username, auth_type, password, key_path,
                         sudo_password, su_password, group_name, timeout_ms)
      VALUES (@name, @host, @port, @username, @authType, @password, @keyPath,
              @sudoPassword, @suPassword, @groupName, @timeoutMs)
      RETURNING *
    `);
    const row = stmt.get({
      name: payload.name,
      host: payload.host,
      port: payload.port,
      username: payload.username,
      authType: payload.authType,
      password: payload.password ? encrypt(payload.password) : null,
      keyPath: payload.keyPath ?? null,
      sudoPassword: payload.sudoPassword ? encrypt(payload.sudoPassword) : null,
      suPassword: payload.suPassword ? encrypt(payload.suPassword) : null,
      groupName: payload.groupName,
      timeoutMs: payload.timeoutMs,
    }) as HostRow;
    return rowToConfig(row);
  },

  update(id: string, payload: Partial<HostInput>): HostConfig {
    const db = getDb();
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Host not found: ${id}`);
    }
    const merged: HostInput = {
      name: payload.name ?? existing.name,
      host: payload.host ?? existing.host,
      port: payload.port ?? existing.port,
      username: payload.username ?? existing.username,
      authType: payload.authType ?? existing.authType,
      password: payload.password ?? existing.password,
      keyPath: payload.keyPath ?? existing.keyPath,
      sudoPassword: payload.sudoPassword ?? existing.sudoPassword,
      suPassword: payload.suPassword ?? existing.suPassword,
      groupName: payload.groupName ?? existing.groupName,
      timeoutMs: payload.timeoutMs ?? existing.timeoutMs,
    };
    db.prepare(
      `
      UPDATE hosts
      SET name = @name, host = @host, port = @port, username = @username,
          auth_type = @authType, password = @password, key_path = @keyPath,
          sudo_password = @sudoPassword, su_password = @suPassword,
          group_name = @groupName, timeout_ms = @timeoutMs,
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
    });
    return this.get(id)!;
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
