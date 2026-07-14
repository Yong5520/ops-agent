import { getDb } from './database.js';
import type { Hook, HookCreateInput, HookEvent, HookType } from '../../shared/types.js';

interface HookRow {
  id: string;
  name: string;
  event: string;
  type: string;
  config: string;
  condition: string;
  enabled: number;
  created_at: string;
}

function rowToHook(row: HookRow): Hook {
  return {
    id: row.id,
    name: row.name,
    event: row.event as HookEvent,
    type: row.type as HookType,
    config: JSON.parse(row.config),
    condition: JSON.parse(row.condition),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export const hooksStore = {
  list(): Hook[] {
    const rows = getDb().prepare('SELECT * FROM hooks ORDER BY created_at DESC').all() as HookRow[];
    return rows.map(rowToHook);
  },

  listEnabled(): Hook[] {
    const rows = getDb()
      .prepare('SELECT * FROM hooks WHERE enabled = 1 ORDER BY created_at DESC')
      .all() as HookRow[];
    return rows.map(rowToHook);
  },

  get(id: string): Hook | null {
    const row = getDb().prepare('SELECT * FROM hooks WHERE id = ?').get(id) as HookRow | undefined;
    return row ? rowToHook(row) : null;
  },

  create(payload: HookCreateInput): Hook {
    const db = getDb();
    const row = db
      .prepare(
        `
      INSERT INTO hooks (name, event, type, config, condition, enabled)
      VALUES (@name, @event, @type, @config, @condition, @enabled)
      RETURNING *
    `,
      )
      .get({
        name: payload.name,
        event: payload.event,
        type: payload.type,
        config: JSON.stringify(payload.config),
        condition: JSON.stringify(payload.condition),
        enabled: payload.enabled ? 1 : 0,
      }) as HookRow;
    return rowToHook(row);
  },

  update(id: string, payload: Partial<HookCreateInput>): Hook {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM hooks WHERE id = ?').get(id) as HookRow | undefined;
    if (!existing) {
      throw new Error(`Hook not found: ${id}`);
    }
    const current = rowToHook(existing);
    const merged: HookCreateInput = {
      name: payload.name ?? current.name,
      event: payload.event ?? current.event,
      type: payload.type ?? current.type,
      config: payload.config ?? current.config,
      condition: payload.condition ?? current.condition,
      enabled: payload.enabled ?? current.enabled,
    };
    db.prepare(
      `
      UPDATE hooks
      SET name = @name, event = @event, type = @type, config = @config, condition = @condition, enabled = @enabled
      WHERE id = @id
    `,
    ).run({
      id,
      name: merged.name,
      event: merged.event,
      type: merged.type,
      config: JSON.stringify(merged.config),
      condition: JSON.stringify(merged.condition),
      enabled: merged.enabled ? 1 : 0,
    });
    const row = db.prepare('SELECT * FROM hooks WHERE id = ?').get(id) as HookRow;
    return rowToHook(row);
  },

  delete(id: string): void {
    getDb().prepare('DELETE FROM hooks WHERE id = ?').run(id);
  },
};
