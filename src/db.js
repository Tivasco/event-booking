import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export const DEFAULT_DB_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data/bookings.db',
);

/**
 * Every connection gets the same pragmas — including connections opened by
 * test worker processes, which is where WAL and busy_timeout actually earn
 * their keep: a single-connection server never contends with itself, but the
 * multi-process concurrency proof (and any second app instance) does.
 * foreign_keys is OFF by default in SQLite and must be enabled per connection.
 */
export function openDb(file = process.env.DB_PATH ?? DEFAULT_DB_PATH) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(schemaPath, 'utf8'));
  return db;
}

/** One canonical datetime format everywhere — stored and compared as this. */
export function nowIso() {
  return new Date().toISOString();
}
