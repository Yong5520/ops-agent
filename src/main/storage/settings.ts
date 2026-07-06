import { getDb } from './database.js';
import type { AppSetting } from '../../shared/types.js';

interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
}

function rowToSetting(row: SettingRow): AppSetting {
  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
  };
}

export const settingsStore = {
  get(key: string): string | null {
    const row = getDb()
      .prepare('SELECT * FROM app_settings WHERE key = ?')
      .get(key) as SettingRow | undefined;
    return row ? row.value : null;
  },

  set(key: string, value: string): AppSetting {
    const db = getDb();
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (@key, @value, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `).run({ key, value });
    const row = db
      .prepare('SELECT * FROM app_settings WHERE key = ?')
      .get(key) as SettingRow;
    return rowToSetting(row);
  },

  getAll(): AppSetting[] {
    const rows = getDb()
      .prepare('SELECT * FROM app_settings ORDER BY key ASC')
      .all() as SettingRow[];
    return rows.map(rowToSetting);
  },

  delete(key: string): void {
    getDb().prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  },
};
