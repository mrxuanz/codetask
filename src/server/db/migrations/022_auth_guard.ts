import type { Migration } from './types'

export const migration022AuthGuard: Migration = {
  version: 22,
  name: 'auth_guard',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_guard_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        fail_count INTEGER NOT NULL DEFAULT 0,
        last_failed_at INTEGER,
        locked_until INTEGER,
        captcha_required INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_rate_bucket (
        bucket_key TEXT NOT NULL,
        bucket_start INTEGER NOT NULL,
        fail_count INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (bucket_key, bucket_start)
      );

      CREATE TABLE IF NOT EXISTS captcha_challenge (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        answer_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `)
  }
}
