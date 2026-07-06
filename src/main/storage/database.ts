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
  const targetVersion = 2;

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
