import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { SCHEMA_STATEMENTS } from './schema.js';
import { verifyCrypto } from './crypto.js';

export type DB = Database.Database;
let db: DB | null = null;

function resolveDbPath(): string {
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  return join(userData, 'ops-agent.db');
}

export function initDatabase(): DB {
  if (db) {
    return db;
  }
  const dbPath = resolveDbPath();
  logger.info(`Opening database at ${dbPath}`);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  runMigrations(db);

  // Verify that credential encryption/decryption works
  if (!verifyCrypto()) {
    logger.warn('Crypto self-test failed — credential encryption may not work correctly');
  } else {
    logger.info('Crypto self-test passed');
  }

  return db;
}

function runMigrations(database: DB): void {
  const currentVersion = getUserVersion(database);
  const targetVersion = 13;

  if (currentVersion < 1) {
    logger.info(`Running migration v1: initial schema`);
    database.exec(SCHEMA_STATEMENTS);
  }

  if (currentVersion < 2) {
    logger.info(`Running migration v2: add sessions.host_ids column`);
    addColumnIfNotExists(database, 'sessions', 'host_ids', 'TEXT');
    // Backfill host_ids from existing host_id values so old sessions keep
    // working in multi-host mode.
    database.exec(
      `UPDATE sessions SET host_ids = '["' || host_id || '"]' WHERE host_id IS NOT NULL AND host_ids IS NULL`,
    );
  }

  if (currentVersion < 3) {
    logger.info(`Running migration v3: add task_lists table + sessions columns + plan mode`);
    // task_lists table (P0-1 TodoWrite)
    database.exec(`
      CREATE TABLE IF NOT EXISTS task_lists (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        todos       TEXT NOT NULL,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_lists_session ON task_lists(session_id);
    `);
    addColumnIfNotExists(database, 'sessions', 'plan_mode', 'INTEGER DEFAULT 0');
    addColumnIfNotExists(database, 'sessions', 'summary', 'TEXT');
    addColumnIfNotExists(database, 'sessions', 'summary_coverage_index', 'INTEGER DEFAULT 0');

    // Recreate sessions table with updated CHECK constraint to include 'plan'
    // Only needed if the existing CHECK doesn't include 'plan'.
    const needsRecreate = !tableCheckHasPlan(database);
    if (needsRecreate) {
      database.pragma('foreign_keys = OFF');
      database.exec(`
        CREATE TABLE sessions_new (
          id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          title       TEXT,
          host_id     TEXT REFERENCES hosts(id) ON DELETE SET NULL,
          host_ids    TEXT,
          safety_mode TEXT NOT NULL DEFAULT 'operator' CHECK (safety_mode IN ('sentinel', 'operator', 'autopilot', 'plan')),
          status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
          plan_mode   INTEGER DEFAULT 0,
          summary     TEXT,
          summary_coverage_index INTEGER DEFAULT 0,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO sessions_new (id, title, host_id, host_ids, safety_mode, status, plan_mode, summary, summary_coverage_index, created_at, updated_at)
        SELECT id, title, host_id, host_ids, safety_mode, status, plan_mode, summary, summary_coverage_index, created_at, updated_at FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, updated_at);
      `);
      database.pragma('foreign_keys = ON');
    }
  }

  if (currentVersion < 4) {
    logger.info(`Running migration v4: add hooks table`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS hooks (
        id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name        TEXT NOT NULL,
        event       TEXT NOT NULL CHECK (event IN ('PreToolUse', 'PostToolUse')),
        type        TEXT NOT NULL CHECK (type IN ('command', 'http')),
        config      TEXT NOT NULL,
        condition   TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hooks_event ON hooks(event, enabled);
    `);
  }

  if (currentVersion < 5) {
    logger.info(`Running migration v5: add audit_logs hash chain columns`);
    addColumnIfNotExists(database, 'audit_logs', 'prev_hash', "TEXT NOT NULL DEFAULT ''");
    addColumnIfNotExists(database, 'audit_logs', 'row_hash', "TEXT NOT NULL DEFAULT ''");
    database.exec(`CREATE INDEX IF NOT EXISTS idx_audit_chain ON audit_logs(created_at);`);
  }

  if (currentVersion < 6) {
    logger.info(`Running migration v6: add context_window column to model_providers`);
    addColumnIfNotExists(database, 'model_providers', 'context_window', 'INTEGER');
  }

  if (currentVersion < 7) {
    logger.info(`Running migration v7: add message_attachments table for multimodal images`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS message_attachments (
        id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type          TEXT NOT NULL DEFAULT 'image' CHECK (type IN ('image')),
        file_path     TEXT NOT NULL,
        mime_type     TEXT NOT NULL,
        original_name TEXT,
        size_bytes    INTEGER NOT NULL,
        width         INTEGER,
        height        INTEGER,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON message_attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_session ON message_attachments(session_id);
    `);
  }

  if (currentVersion < 8) {
    logger.info(`Running migration v8: add thinking_blocks column to messages`);
    // JSON array of ThinkingBlock ({ id, content, durationMs? }). NULL for
    // non-thinking models and legacy messages (parsed from <think> tags at
    // render time in that case).
    addColumnIfNotExists(database, 'messages', 'thinking_blocks', 'TEXT');
  }

  if (currentVersion < 9) {
    // v9 was reserved for sessions.model_provider_id (per-session model
    // switching). An earlier interrupted session bumped targetVersion to 9
    // WITHOUT adding this block, so DBs that ran in that state are now at
    // user_version=9 but lack the column. The v10 block below re-adds it
    // idempotently (addColumnIfNotExists checks PRAGMA table_info), so this
    // v9 block is intentionally a no-op - kept only so the version gap is
    // documented. The real work happens in v10.
    logger.info(`Running migration v9: (reserved) sessions.model_provider_id`);
  }

  if (currentVersion < 10) {
    // Per-session model override. Nullable: NULL means "use the global
    // active default". ON DELETE SET NULL so deleting a provider resets
    // affected sessions to the default instead of orphaning them.
    // Idempotent (addColumnIfNotExists) so this also repairs DBs that were
    // bumped to v9 without the column by the interrupted session.
    logger.info(`Running migration v10: add model_provider_id to sessions`);
    addColumnIfNotExists(
      database,
      'sessions',
      'model_provider_id',
      'TEXT REFERENCES model_providers(id) ON DELETE SET NULL',
    );
    // Defense-in-depth: also (re)add thinking_blocks to messages. A v9 DB
    // created by the interrupted session would have run the v8 block, so this
    // is normally a no-op - but addColumnIfNotExists is idempotent and costs
    // nothing, and it guards against any DB that reached v9 without the column
    // (which would otherwise break INSERT INTO messages (... thinking_blocks)).
    addColumnIfNotExists(database, 'messages', 'thinking_blocks', 'TEXT');
  }

  if (currentVersion < 11) {
    // V3-01: cost & token tracking. session_costs table (one row per agent
    // turn) + per-million-token pricing columns on model_providers (editable
    // in Settings, all nullable so existing providers default to "no pricing"
    // -> estimated_usd = 0, tokens still persisted). Both additive and
    // idempotent - safe on fresh installs (table already created by the v1
    // SCHEMA_STATEMENTS) and on upgraded DBs.
    logger.info(`Running migration v11: session_costs table + model_providers pricing`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS session_costs (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id             TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        model_provider_id      TEXT REFERENCES model_providers(id) ON DELETE SET NULL,
        prompt_tokens          INTEGER NOT NULL DEFAULT 0,
        completion_tokens      INTEGER NOT NULL DEFAULT 0,
        total_tokens           INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
        estimated_usd          REAL NOT NULL DEFAULT 0,
        created_at             TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_session_costs_session ON session_costs(session_id, created_at);
    `);
    addColumnIfNotExists(database, 'model_providers', 'input_price_per_mtok', 'REAL');
    addColumnIfNotExists(database, 'model_providers', 'output_price_per_mtok', 'REAL');
    addColumnIfNotExists(database, 'model_providers', 'cache_read_price_per_mtok', 'REAL');
    addColumnIfNotExists(database, 'model_providers', 'cache_creation_price_per_mtok', 'REAL');
  }

  if (currentVersion < 12) {
    // V14: host_groups table - lets users explicitly create (possibly empty)
    // host folders. Folders were previously implicit (distinct group_name on
    // hosts), so empty folders could not persist. Seed existing non-default
    // group names so current folders remain manageable. Additive + idempotent.
    logger.info(`Running migration v12: host_groups table (explicit host folders)`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS host_groups (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_host_groups_name ON host_groups(name);
      INSERT OR IGNORE INTO host_groups (name)
        SELECT DISTINCT group_name FROM hosts
        WHERE group_name IS NOT NULL AND group_name <> 'default';
    `);
  }

  if (currentVersion < 13) {
    // V3-09: SSH bastion / agent forwarding / host-key verification. Three
    // additive, nullable columns on hosts. All default safely so existing
    // hosts behave exactly as before (no jump host, no agent forwarding, no
    // fingerprint -> TOFU records it on next connect). Idempotent via
    // addColumnIfNotExists.
    logger.info(`Running migration v13: hosts SSH bastion/agentForward/hostKey columns`);
    addColumnIfNotExists(database, 'hosts', 'jump_host_id', 'TEXT');
    addColumnIfNotExists(database, 'hosts', 'agent_forward', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfNotExists(database, 'hosts', 'host_key_fingerprint', 'TEXT');
  }

  setUserVersion(database, targetVersion);
  logger.info(`Database schema at v${targetVersion}`);
}

// Check if a column exists in a table.
function columnExists(database: DB, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

// Add a column only if it doesn't already exist (idempotent migration).
function addColumnIfNotExists(
  database: DB,
  table: string,
  column: string,
  definition: string,
): void {
  if (!columnExists(database, table, column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Check if sessions.safety_mode CHECK constraint includes 'plan'.
function tableCheckHasPlan(database: DB): boolean {
  const sql = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'`)
    .get() as { sql?: string } | undefined;
  if (!sql?.sql) return false;
  return sql.sql.includes("'plan'");
}

function getUserVersion(database: DB): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: number };
  return row?.user_version ?? 0;
}

function setUserVersion(database: DB, version: number): void {
  database.pragma(`user_version = ${version}`);
}

export function getDb(): DB {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}
