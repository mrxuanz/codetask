import type { Migration } from './types'

function columnExists(
  db: import('better-sqlite3').Database,
  table: string,
  column: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((col) => col.name === column)
}

function tableExists(db: import('better-sqlite3').Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return Boolean(row)
}

export const migration015MessagePayloadRetention: Migration = {
  version: 15,
  name: 'message_payload_retention',
  up(db) {
    if (!tableExists(db, 'message_artifacts')) {
      db.exec(`
        CREATE TABLE message_artifacts (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES thread_messages(id) ON DELETE CASCADE,
          kind TEXT NOT NULL DEFAULT 'payload',
          content_hash TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          storage TEXT NOT NULL CHECK (storage IN ('inline', 'file')),
          content_inline TEXT,
          content_path TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_message_artifacts_message_kind
          ON message_artifacts (message_id, kind);
      `)
    }

    if (!columnExists(db, 'thread_messages', 'payload_artifact_id')) {
      db.exec(`ALTER TABLE thread_messages ADD COLUMN payload_artifact_id TEXT`)
    }
  }
}
