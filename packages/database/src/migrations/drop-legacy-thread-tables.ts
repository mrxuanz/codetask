import type Database from 'better-sqlite3'

export type BatchIDropThreadsMigration = {
  version: number
  name: string
  up: (db: Database.Database) => void
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

/**
 * Batch I / R5: drop legacy `threads` / `thread_messages`.
 * Detaches `message_artifacts` FK first (payload retention keeps opaque message ids).
 */
export const migration065DropLegacyThreadTables: BatchIDropThreadsMigration = {
  version: 65,
  name: 'drop_legacy_thread_tables',
  up(db) {
    db.pragma('foreign_keys = OFF')
    try {
      if (tableExists(db, 'message_artifacts')) {
        db.exec(`
          CREATE TABLE message_artifacts_live (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'payload',
            content_hash TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            storage TEXT NOT NULL CHECK (storage IN ('inline', 'file')),
            content_inline TEXT,
            content_path TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER
          );
          INSERT INTO message_artifacts_live (
            id, message_id, kind, content_hash, byte_size, storage,
            content_inline, content_path, created_at, expires_at
          )
          SELECT
            id, message_id, kind, content_hash, byte_size, storage,
            content_inline, content_path, created_at, expires_at
          FROM message_artifacts;
          DROP TABLE message_artifacts;
          ALTER TABLE message_artifacts_live RENAME TO message_artifacts;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_message_artifacts_message_kind
            ON message_artifacts (message_id, kind);
        `)
      }

      if (tableExists(db, 'thread_messages')) {
        db.exec(`DROP TABLE thread_messages`)
      }
      if (tableExists(db, 'threads')) {
        db.exec(`DROP TABLE threads`)
      }
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }
}
