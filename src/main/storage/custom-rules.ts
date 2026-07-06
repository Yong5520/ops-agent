import { getDb } from './database.js';
import type { CustomRule, CustomRuleInput } from '../../shared/types.js';

interface RuleRow {
  id: string;
  type: string;
  pattern: string;
  reason: string;
  host_id: string | null;
  created_at: string;
}

function rowToRule(row: RuleRow): CustomRule {
  return {
    id: row.id,
    type: row.type as 'blocked' | 'allowed',
    pattern: row.pattern,
    reason: row.reason,
    hostId: row.host_id ?? undefined,
    createdAt: row.created_at,
  };
}

export const customRulesStore = {
  list(): CustomRule[] {
    const rows = getDb()
      .prepare('SELECT * FROM custom_rules ORDER BY created_at DESC')
      .all() as RuleRow[];
    return rows.map(rowToRule);
  },

  listByHost(hostId?: string): CustomRule[] {
    if (hostId) {
      const rows = getDb()
        .prepare(
          `SELECT * FROM custom_rules WHERE host_id = ? OR host_id IS NULL ORDER BY created_at DESC`,
        )
        .all(hostId) as RuleRow[];
      return rows.map(rowToRule);
    }
    const rows = getDb()
      .prepare('SELECT * FROM custom_rules WHERE host_id IS NULL ORDER BY created_at DESC')
      .all() as RuleRow[];
    return rows.map(rowToRule);
  },

  create(payload: CustomRuleInput): CustomRule {
    const db = getDb();
    const row = db
      .prepare(
        `
      INSERT INTO custom_rules (type, pattern, reason, host_id)
      VALUES (@type, @pattern, @reason, @hostId)
      RETURNING *
    `,
      )
      .get({
        type: payload.type,
        pattern: payload.pattern,
        reason: payload.reason,
        hostId: payload.hostId ?? null,
      }) as RuleRow;
    return rowToRule(row);
  },

  update(id: string, payload: Partial<CustomRuleInput>): CustomRule {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM custom_rules WHERE id = ?').get(id) as
      RuleRow | undefined;
    if (!existing) {
      throw new Error(`Custom rule not found: ${id}`);
    }
    db.prepare(
      `
      UPDATE custom_rules
      SET type = @type, pattern = @pattern, reason = @reason, host_id = @hostId
      WHERE id = @id
    `,
    ).run({
      id,
      type: payload.type ?? existing.type,
      pattern: payload.pattern ?? existing.pattern,
      reason: payload.reason ?? existing.reason,
      hostId: payload.hostId ?? existing.host_id,
    });
    const row = db.prepare('SELECT * FROM custom_rules WHERE id = ?').get(id) as RuleRow;
    return rowToRule(row);
  },

  delete(id: string): void {
    getDb().prepare('DELETE FROM custom_rules WHERE id = ?').run(id);
  },
};
