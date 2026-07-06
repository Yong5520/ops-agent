import { getDb } from './database.js';
import { encrypt, decrypt } from './crypto.js';
import type { ModelProvider, ModelProviderInput } from '../../shared/types.js';

interface ModelRow {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  api_key: string;
  model_name: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function rowToProvider(row: ModelRow, includeSecret = false): ModelProvider {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ModelProvider['type'],
    endpoint: row.endpoint,
    apiKey: includeSecret ? decrypt(row.api_key) : undefined,
    modelName: row.model_name,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const modelsStore = {
  list(): ModelProvider[] {
    const rows = getDb()
      .prepare('SELECT * FROM model_providers ORDER BY name ASC')
      .all() as ModelRow[];
    return rows.map((r) => rowToProvider(r));
  },

  get(id: string): ModelProvider | null {
    const row = getDb().prepare('SELECT * FROM model_providers WHERE id = ?').get(id) as
      ModelRow | undefined;
    return row ? rowToProvider(row) : null;
  },

  getWithSecret(id: string): ModelProvider | null {
    const row = getDb().prepare('SELECT * FROM model_providers WHERE id = ?').get(id) as
      ModelRow | undefined;
    return row ? rowToProvider(row, true) : null;
  },

  getActive(): ModelProvider | null {
    const row = getDb()
      .prepare('SELECT * FROM model_providers WHERE is_active = 1 LIMIT 1')
      .get() as ModelRow | undefined;
    return row ? rowToProvider(row, true) : null;
  },

  create(payload: ModelProviderInput): ModelProvider {
    if (!payload.apiKey) {
      throw new Error('API Key 不能为空');
    }
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO model_providers (name, type, endpoint, api_key, model_name)
      VALUES (@name, @type, @endpoint, @apiKey, @modelName)
      RETURNING *
    `);
    const row = stmt.get({
      name: payload.name,
      type: payload.type,
      endpoint: payload.endpoint,
      apiKey: encrypt(payload.apiKey),
      modelName: payload.modelName,
    }) as ModelRow;
    return rowToProvider(row);
  },

  update(id: string, payload: Partial<ModelProviderInput>): ModelProvider {
    const db = getDb();
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Model provider not found: ${id}`);
    }
    const apiKeyStored = payload.apiKey
      ? encrypt(payload.apiKey)
      : (
          db.prepare('SELECT api_key FROM model_providers WHERE id = ?').get(id) as Pick<
            ModelRow,
            'api_key'
          >
        ).api_key;

    db.prepare(
      `
      UPDATE model_providers
      SET name = @name, type = @type, endpoint = @endpoint, api_key = @apiKey,
          model_name = @modelName, updated_at = datetime('now')
      WHERE id = @id
    `,
    ).run({
      id,
      name: payload.name ?? existing.name,
      type: payload.type ?? existing.type,
      endpoint: payload.endpoint ?? existing.endpoint,
      apiKey: apiKeyStored,
      modelName: payload.modelName ?? existing.modelName,
    });
    return this.get(id)!;
  },

  delete(id: string): void {
    getDb().prepare('DELETE FROM model_providers WHERE id = ?').run(id);
  },

  setActive(id: string): void {
    const db = getDb();
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Model provider not found: ${id}`);
    }
    const tx = db.transaction(() => {
      db.prepare('UPDATE model_providers SET is_active = 0').run();
      db.prepare(
        "UPDATE model_providers SET is_active = 1, updated_at = datetime('now') WHERE id = ?",
      ).run(id);
    });
    tx();
  },
};
