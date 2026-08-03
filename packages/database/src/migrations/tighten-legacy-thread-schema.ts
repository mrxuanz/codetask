import type Database from 'better-sqlite3'
import type { ConversationMigration } from './conversation.ts'

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

function resolveActorId(
  db: Database.Database,
  owner: string
): string {
  if (!tableExists(db, 'auth_users')) return owner
  const byId = db.prepare(`SELECT id FROM auth_users WHERE id = ? LIMIT 1`).get(owner) as
    | { id: string }
    | undefined
  if (byId) return byId.id
  const byName = db
    .prepare(`SELECT id FROM auth_users WHERE username = ? LIMIT 1`)
    .get(owner) as { id: string } | undefined
  if (byName) return byName.id
  const singleton = db
    .prepare(`SELECT id FROM auth_users WHERE singleton_key = 1 LIMIT 1`)
    .get() as { id: string } | undefined
  return singleton?.id ?? owner
}

/**
 * Drop upgrade-compat leftovers from live threads / thread_messages (03 §14 / 04 Actor):
 * - threads.username → actor_id
 * - thread_kind CHECK → chat only
 * - message kind CHECK → text only (normalize task-launch-draft / wizard-handoff)
 *
 * Historical migration files stay intact so old installs can still upgrade into this shape.
 */
export const migration056TightenLegacyThreadSchema: ConversationMigration = {
  version: 56,
  name: 'tighten_legacy_thread_schema',
  up(db) {
    if (!tableExists(db, 'threads')) return

    db.exec(`
      DROP TRIGGER IF EXISTS threads_active_draft_insert;
      DROP TRIGGER IF EXISTS threads_active_draft_update;
      DROP TRIGGER IF EXISTS thread_messages_clear_active_draft;
      DROP TRIGGER IF EXISTS thread_jobs_draft_same_thread_insert;
      DROP TRIGGER IF EXISTS thread_jobs_draft_same_thread_update;
      DROP TRIGGER IF EXISTS threads_active_plan_insert;
      DROP TRIGGER IF EXISTS threads_active_plan_update;
      DROP TRIGGER IF EXISTS thread_jobs_clear_active_plan;
      DROP TRIGGER IF EXISTS design_sessions_clear_active_plan;
    `)

    if (tableExists(db, 'thread_messages')) {
      db.exec(`
        UPDATE thread_messages
        SET kind = 'text'
        WHERE kind IN ('task-launch-draft', 'wizard-handoff')
           OR kind NOT IN ('text')
      `)
    }

    db.exec(`
      UPDATE threads
      SET thread_kind = 'chat'
      WHERE thread_kind IS NULL OR thread_kind != 'chat'
    `)

    const threadCols = columnNames(db, 'threads')
    const alreadyTight =
      threadCols.has('actor_id') &&
      !threadCols.has('username') &&
      (() => {
        const sql = (
          db
            .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='threads'`)
            .get() as { sql?: string } | undefined
        )?.sql
        return (
          Boolean(sql?.includes("thread_kind IN ('chat')")) &&
          !sql?.includes('create_task') &&
          !sql?.includes('task_snapshot')
        )
      })()

    if (!alreadyTight) {
      rebuildThreads(db, threadCols)
    }

    if (tableExists(db, 'thread_messages')) {
      const messageSql = (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='thread_messages'`)
          .get() as { sql?: string } | undefined
      )?.sql
      const messagesTight =
        Boolean(messageSql?.includes("kind IN ('text')")) &&
        !messageSql?.includes('task-launch-draft') &&
        !messageSql?.includes('wizard-handoff')
      if (!messagesTight) {
        rebuildThreadMessages(db)
      }
    }

    if (tableExists(db, 'thread_jobs') && tableExists(db, 'thread_messages')) {
      db.exec(`
        DROP TRIGGER IF EXISTS thread_jobs_draft_same_thread_insert;
        CREATE TRIGGER thread_jobs_draft_same_thread_insert
        BEFORE INSERT ON thread_jobs
        BEGIN
          SELECT CASE
            WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.draft_message_id) IS NULL
              THEN RAISE(ABORT, 'draft_message_id must reference an existing message')
            WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.draft_message_id) != NEW.thread_id
              THEN RAISE(ABORT, 'draft_message_id must belong to the same thread')
          END;
        END;

        DROP TRIGGER IF EXISTS thread_jobs_draft_same_thread_update;
        CREATE TRIGGER thread_jobs_draft_same_thread_update
        BEFORE UPDATE OF draft_message_id, thread_id ON thread_jobs
        BEGIN
          SELECT CASE
            WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.draft_message_id) IS NULL
              THEN RAISE(ABORT, 'draft_message_id must reference an existing message')
            WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.draft_message_id) != NEW.thread_id
              THEN RAISE(ABORT, 'draft_message_id must belong to the same thread')
          END;
        END;
      `)
    }
  }
}

function rebuildThreads(db: Database.Database, threadCols: Set<string>): void {
  db.pragma('foreign_keys = OFF')
  db.exec(`
    CREATE TABLE threads_live (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      core_code TEXT NOT NULL,
      runtime_status TEXT NOT NULL,
      runtime_session_id TEXT,
      core_runtime_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      last_used_at INTEGER,
      title_source TEXT NOT NULL DEFAULT 'auto',
      thread_kind TEXT NOT NULL DEFAULT 'chat' CHECK (thread_kind IN ('chat')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  const ownerExpr = threadCols.has('actor_id')
    ? 'actor_id'
    : threadCols.has('username')
      ? 'username'
      : `'unknown'`

  const rows = db
    .prepare(
      `SELECT id, ${ownerExpr} AS owner, project_id, title, status, conversation_id, core_code,
              runtime_status, runtime_session_id, core_runtime_json, last_error, last_used_at,
              title_source, thread_kind, created_at, updated_at
       FROM threads`
    )
    .all() as Array<{
    id: string
    owner: string
    project_id: string
    title: string
    status: string
    conversation_id: string
    core_code: string
    runtime_status: string
    runtime_session_id: string | null
    core_runtime_json: string
    last_error: string | null
    last_used_at: number | null
    title_source: string
    thread_kind: string
    created_at: number
    updated_at: number
  }>

  const insert = db.prepare(`
    INSERT INTO threads_live (
      id, actor_id, project_id, title, status, conversation_id, core_code,
      runtime_status, runtime_session_id, core_runtime_json, last_error, last_used_at,
      title_source, thread_kind, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'chat', ?, ?)
  `)

  for (const row of rows) {
    insert.run(
      row.id,
      resolveActorId(db, row.owner),
      row.project_id,
      row.title,
      row.status,
      row.conversation_id,
      row.core_code,
      row.runtime_status,
      row.runtime_session_id,
      row.core_runtime_json ?? '{}',
      row.last_error,
      row.last_used_at,
      row.title_source || 'auto',
      row.created_at,
      row.updated_at
    )
  }

  db.exec(`
    DROP TABLE threads;
    ALTER TABLE threads_live RENAME TO threads;
    CREATE INDEX IF NOT EXISTS idx_threads_actor_updated ON threads (actor_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_project_updated ON threads (project_id, updated_at DESC);
  `)
  db.pragma('foreign_keys = ON')
}

function rebuildThreadMessages(db: Database.Database): void {
  const cols = columnNames(db, 'thread_messages')
  const hasPayloadArtifact = cols.has('payload_artifact_id')

  db.pragma('foreign_keys = OFF')
  db.exec(`
    CREATE TABLE thread_messages_live (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('text')),
      content TEXT NOT NULL,
      core_code TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      runtime_session_id TEXT,
      payload_json TEXT,
      ${hasPayloadArtifact ? 'payload_artifact_id TEXT,' : ''}
      attachments_json TEXT,
      created_at TEXT NOT NULL
    );
  `)

  const artifactCol = hasPayloadArtifact ? ', payload_artifact_id' : ''

  db.exec(`
    INSERT INTO thread_messages_live (
      id, thread_id, username, role, kind, content, core_code, conversation_id,
      runtime_session_id, payload_json${artifactCol}, attachments_json, created_at
    )
    SELECT
      id, thread_id, username, role, 'text', content, core_code, conversation_id,
      runtime_session_id, payload_json${artifactCol}, attachments_json, created_at
    FROM thread_messages;

    DROP TABLE thread_messages;
    ALTER TABLE thread_messages_live RENAME TO thread_messages;
    CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_created
      ON thread_messages (thread_id, created_at DESC);
  `)
  db.pragma('foreign_keys = ON')
}
