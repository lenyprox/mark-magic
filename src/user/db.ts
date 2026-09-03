// The read-write user database (decks, games, caches, metagame). Created on first open; migrations run in-process.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { USER_DB } from '../config/paths.js';
import { MIGRATIONS } from './migrations.js';

export function openUserDb(dbPath = USER_DB()): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Database.Database): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(r => r.version));
  let ran = 0;
  MIGRATIONS.forEach((sql, i) => {
    const v = i + 1; if (applied.has(v)) return;
    db.transaction(() => { db.exec(sql); db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(v, new Date().toISOString()); })();
    ran++;
  });
  return ran;
}

export function schemaVersion(db: Database.Database): number {
  return (db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0;
}

export function getSetting<T = string>(db: Database.Database, key: string, fallback: T): T {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!r) return fallback;
  try { return JSON.parse(r.value) as T; } catch { return r.value as unknown as T; }
}
export function setSetting(db: Database.Database, key: string, value: unknown) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
