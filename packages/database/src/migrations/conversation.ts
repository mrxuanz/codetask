import type Database from 'better-sqlite3'

export type ConversationMigration = {
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

function columnNames(db: Database.Database, table: string): Set<string> {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(cols.map((c) => c.name))
}

/** Create Conversation-owned tables + agent_runtime_bindings (03 §14). */
export const migration048ConversationModuleTables: ConversationMigration = {
  version: 48,
  name: 'conversation_module_tables',
  up(db) {
    // Old 036 conversation_turns collides with the new schema name — archive first.
    if (tableExists(db, 'conversation_turns')) {
      const cols = columnNames(db, 'conversation_turns')
      if (cols.has('thread_id') && cols.has('kind') && !cols.has('conversation_id')) {
        if (!tableExists(db, 'conversation_turns_legacy')) {
          db.exec(`ALTER TABLE conversation_turns RENAME TO conversation_turns_legacy`)
        }
      }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_threads (
        id TEXT PRIMARY KEY NOT NULL,
        actor_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        title_source TEXT NOT NULL DEFAULT 'auto',
        provider_code TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        state_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_threads_actor
        ON conversation_threads(actor_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_conversation_threads_project
        ON conversation_threads(project_id, updated_at);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        turn_id TEXT,
        role TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        content TEXT NOT NULL,
        provider_code TEXT,
        model TEXT,
        thinking_text TEXT,
        thinking_duration_ms INTEGER,
        thinking_artifact_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation
        ON conversation_messages(conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS conversation_message_attachments (
        id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT REFERENCES conversation_messages(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        kind TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_attachments_conversation
        ON conversation_message_attachments(conversation_id);

      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL,
        state TEXT NOT NULL,
        input_text TEXT NOT NULL DEFAULT '',
        provider_code TEXT NOT NULL,
        workspace_access TEXT NOT NULL DEFAULT 'live-read',
        settings_snapshot_json TEXT NOT NULL DEFAULT '{}',
        settings_hash TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT,
        request_hash TEXT NOT NULL DEFAULT '',
        state_revision INTEGER NOT NULL DEFAULT 1,
        user_message_id TEXT,
        assistant_message_id TEXT,
        last_error_json TEXT,
        created_at TEXT NOT NULL,
        admitted_at TEXT,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turns_idempotency
        ON conversation_turns(actor_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_conversation_state
        ON conversation_turns(conversation_id, state, created_at);
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_actor_state
        ON conversation_turns(actor_id, state);

      CREATE TABLE IF NOT EXISTS conversation_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        turn_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_outbox_pending
        ON conversation_outbox(dispatched_at, created_at);

      CREATE TABLE IF NOT EXISTS agent_runtime_bindings (
        scope_id TEXT PRIMARY KEY NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        provider_code TEXT NOT NULL,
        provider_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_bindings_owner
        ON agent_runtime_bindings(owner_type, owner_id);
    `)
  }
}
