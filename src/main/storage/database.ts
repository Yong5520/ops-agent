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
  const targetVersion = 6;

  if (currentVersion < 1) {
    logger.info(`Running migration v1: initial schema`);
    database.exec(SCHEMA_STATEMENTS);
  }

  if (currentVersion < 2) {
    logger.info(`Running migration v2: add sessions.host_ids column`);
    // Add the new host_ids column (JSON array). The legacy host_id column is
    // kept for backward compatibility but no longer written by new code.
    database.exec(`ALTER TABLE sessions ADD COLUMN host_ids TEXT`);
    // Backfill host_ids from existing host_id values so old sessions keep
    // working in multi-host mode.
    database.exec(
      `UPDATE sessions SET host_ids = '["' || host_id || '"]' WHERE host_id IS NOT NULL`,
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
    // plan_mode column (P0-1 Plan Mode): 0=off, 1=on
    database.exec(`ALTER TABLE sessions ADD COLUMN plan_mode INTEGER DEFAULT 0`);
    // summary columns (P0-2 Summary persistence)
    database.exec(`ALTER TABLE sessions ADD COLUMN summary TEXT`);
    database.exec(`ALTER TABLE sessions ADD COLUMN summary_coverage_index INTEGER DEFAULT 0`);

    // Recreate sessions table with updated CHECK constraint to include 'plan'
    // SQLite doesn't support ALTER TABLE to modify constraints, so we use the
    // create-copy-drop-rename pattern with foreign keys temporarily disabled.
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
    database.exec(`
      ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE audit_logs ADD COLUMN row_hash TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_audit_chain ON audit_logs(created_at);
    `);
  }

  if (currentVersion < 6) {
    logger.info(`Running migration v6: add context_window column to model_providers`);
    database.exec(`
      ALTER TABLE model_providers ADD COLUMN context_window INTEGER;
    `);
  }

  setUserVersion(database, targetVersion);
  logger.info(`Database schema at v${targetVersion}`);
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
