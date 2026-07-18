import type { Migration } from './types'

function tableExists(db: import('better-sqlite3').Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return Boolean(row?.name)
}

export const migration036ConversationTurns: Migration = {
  version: 36,
  name: 'conversation_turns',
  up(db) {
    if (tableExists(db, 'conversation_turns')) return

    db.exec(`
      CREATE TABLE conversation_turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_access TEXT NOT NULL DEFAULT 'live-read',
        provider TEXT,
        message_text TEXT NOT NULL DEFAULT '',
        generate_draft INTEGER NOT NULL DEFAULT 0,
        create_task_mode INTEGER NOT NULL DEFAULT 0,
        attachment_ids_json TEXT NOT NULL DEFAULT '[]',
        selected_draft_section TEXT,
        selected_plan_node_ref TEXT,
        idempotency_key TEXT,
        state_revision INTEGER NOT NULL DEFAULT 1,
        last_error_json TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      );
      CREATE INDEX idx_conversation_turns_thread_status
        ON conversation_turns (thread_id, status, created_at);
      CREATE INDEX idx_conversation_turns_user_status
        ON conversation_turns (username, status, created_at);
      CREATE UNIQUE INDEX idx_conversation_turns_idempotency
        ON conversation_turns (username, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `)
  }
}
