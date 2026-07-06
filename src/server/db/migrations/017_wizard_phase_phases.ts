import type { Migration } from './types'
import {
  MESSAGE_KINDS,
  MESSAGE_ROLES,
  RUNTIME_STATUSES,
  sqlInList,
  THREAD_KINDS,
  THREAD_STATUSES,
  TITLE_SOURCES,
  WIZARD_PHASES
} from '../constraints'
import {
  createThreadMessagePointerTriggers,
  dropThreadMessagePointerTriggers
} from './thread-message-pointer-triggers'
import {
  createThreadPlanPointerTriggers,
  dropThreadPlanPointerTriggers
} from './thread-plan-pointer-triggers'

function tableExists(db: import('better-sqlite3').Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return Boolean(row)
}

function columnExists(
  db: import('better-sqlite3').Database,
  table: string,
  column: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((col) => col.name === column)
}

export const migration017WizardPhasePhases: Migration = {
  version: 17,
  name: 'wizard_phase_phases',
  up(db) {
    if (!tableExists(db, 'threads') || !tableExists(db, 'thread_messages')) return

    dropThreadMessagePointerTriggers(db)
    dropThreadPlanPointerTriggers(db)
    db.pragma('foreign_keys = OFF')

    db.exec(`
      CREATE TABLE threads_new (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (${sqlInList(THREAD_STATUSES)})),
        conversation_id TEXT NOT NULL,
        core_code TEXT NOT NULL,
        runtime_status TEXT NOT NULL CHECK (runtime_status IN (${sqlInList(RUNTIME_STATUSES)})),
        runtime_session_id TEXT,
        core_runtime_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        last_used_at INTEGER,
        title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN (${sqlInList(TITLE_SOURCES)})),
        active_draft_id TEXT,
        active_plan_id TEXT,
        wizard_phase TEXT NOT NULL DEFAULT 'collect' CHECK (wizard_phase IN (${sqlInList(WIZARD_PHASES)})),
        thread_kind TEXT NOT NULL DEFAULT 'chat' CHECK (thread_kind IN (${sqlInList(THREAD_KINDS)})),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO threads_new SELECT * FROM threads;
      DROP TABLE threads;
      ALTER TABLE threads_new RENAME TO threads;

      CREATE INDEX IF NOT EXISTS idx_threads_user_updated
        ON threads (username, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_project_updated
        ON threads (project_id, updated_at DESC);
    `)

    const payloadArtifactCol = columnExists(db, 'thread_messages', 'payload_artifact_id')
      ? 'payload_artifact_id TEXT,'
      : ''

    db.exec(`
      CREATE TABLE thread_messages_new (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN (${sqlInList(MESSAGE_ROLES)})),
        kind TEXT NOT NULL CHECK (kind IN (${sqlInList(MESSAGE_KINDS)})),
        content TEXT NOT NULL,
        core_code TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        runtime_session_id TEXT,
        payload_json TEXT,
        ${payloadArtifactCol}
        attachments_json TEXT,
        wizard_phase TEXT CHECK (wizard_phase IS NULL OR wizard_phase IN (${sqlInList(WIZARD_PHASES)})),
        created_at TEXT NOT NULL
      );

      INSERT INTO thread_messages_new (
        id, thread_id, username, role, kind, content, core_code, conversation_id,
        runtime_session_id, payload_json${payloadArtifactCol ? ', payload_artifact_id' : ''},
        attachments_json, wizard_phase, created_at
      )
      SELECT
        id, thread_id, username, role, kind, content, core_code, conversation_id,
        runtime_session_id, payload_json${payloadArtifactCol ? ', payload_artifact_id' : ''},
        attachments_json, wizard_phase, created_at
      FROM thread_messages;

      DROP TABLE thread_messages;
      ALTER TABLE thread_messages_new RENAME TO thread_messages;

      CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_created
        ON thread_messages (thread_id, created_at DESC);
    `)

    db.pragma('foreign_keys = ON')
    createThreadMessagePointerTriggers(db)
    createThreadPlanPointerTriggers(db)
  }
}
