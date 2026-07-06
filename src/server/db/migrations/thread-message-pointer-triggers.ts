import type Database from 'better-sqlite3'
import { MESSAGE_KINDS, MESSAGE_ROLES, sqlInList, WIZARD_PHASES } from '../constraints'

export function dropThreadMessagePointerTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS threads_active_draft_insert;
    DROP TRIGGER IF EXISTS threads_active_draft_update;
    DROP TRIGGER IF EXISTS thread_messages_clear_active_draft;
    DROP TRIGGER IF EXISTS thread_jobs_draft_same_thread_insert;
    DROP TRIGGER IF EXISTS thread_jobs_draft_same_thread_update;
  `)
}

export function createThreadMessagePointerTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS threads_active_draft_insert;
    CREATE TRIGGER threads_active_draft_insert
    BEFORE INSERT ON threads
    WHEN NEW.active_draft_id IS NOT NULL
    BEGIN
      SELECT CASE
        WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.active_draft_id) IS NULL
          THEN RAISE(ABORT, 'active_draft_id must reference an existing message')
        WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.active_draft_id) != NEW.id
          THEN RAISE(ABORT, 'active_draft_id must belong to the same thread')
        WHEN (SELECT kind FROM thread_messages WHERE id = NEW.active_draft_id) != 'task-launch-draft'
          THEN RAISE(ABORT, 'active_draft_id must reference a task-launch-draft message')
      END;
    END;

    DROP TRIGGER IF EXISTS threads_active_draft_update;
    CREATE TRIGGER threads_active_draft_update
    BEFORE UPDATE OF active_draft_id ON threads
    WHEN NEW.active_draft_id IS NOT NULL
    BEGIN
      SELECT CASE
        WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.active_draft_id) IS NULL
          THEN RAISE(ABORT, 'active_draft_id must reference an existing message')
        WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.active_draft_id) != NEW.id
          THEN RAISE(ABORT, 'active_draft_id must belong to the same thread')
        WHEN (SELECT kind FROM thread_messages WHERE id = NEW.active_draft_id) != 'task-launch-draft'
          THEN RAISE(ABORT, 'active_draft_id must reference a task-launch-draft message')
      END;
    END;

    DROP TRIGGER IF EXISTS thread_messages_clear_active_draft;
    CREATE TRIGGER thread_messages_clear_active_draft
    AFTER DELETE ON thread_messages
    BEGIN
      UPDATE threads
      SET active_draft_id = NULL
      WHERE active_draft_id = OLD.id;
    END;

    DROP TRIGGER IF EXISTS thread_jobs_draft_same_thread_insert;
    CREATE TRIGGER thread_jobs_draft_same_thread_insert
    BEFORE INSERT ON thread_jobs
    BEGIN
      SELECT CASE
        WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.draft_message_id) IS NULL
          THEN RAISE(ABORT, 'draft_message_id must reference an existing message')
        WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.draft_message_id) != NEW.thread_id
          THEN RAISE(ABORT, 'draft_message_id must belong to the same thread')
        WHEN (SELECT kind FROM thread_messages WHERE id = NEW.draft_message_id) != 'task-launch-draft'
          THEN RAISE(ABORT, 'draft_message_id must reference a task-launch-draft message')
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
        WHEN (SELECT kind FROM thread_messages WHERE id = NEW.draft_message_id) != 'task-launch-draft'
          THEN RAISE(ABORT, 'draft_message_id must reference a task-launch-draft message')
      END;
    END;
  `)
}

export function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

export function threadMessagesAllowsWizardHandoff(db: Database.Database): boolean {
  if (!tableExists(db, 'thread_messages')) return false
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'thread_messages'`)
    .get() as { sql?: string } | undefined
  return row?.sql?.includes('wizard-handoff') ?? false
}

export function repairMissingThreadMessagesTable(db: Database.Database): boolean {
  if (tableExists(db, 'thread_messages')) return false

  dropThreadMessagePointerTriggers(db)
  db.pragma('foreign_keys = OFF')

  if (tableExists(db, 'thread_messages_new')) {
    db.exec(`ALTER TABLE thread_messages_new RENAME TO thread_messages`)
  } else {
    db.exec(`
      CREATE TABLE thread_messages (
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
        attachments_json TEXT,
        wizard_phase TEXT CHECK (wizard_phase IS NULL OR wizard_phase IN (${sqlInList(WIZARD_PHASES)})),
        created_at TEXT NOT NULL
      );
    `)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_created
      ON thread_messages (thread_id, created_at DESC);
  `)
  db.pragma('foreign_keys = ON')
  createThreadMessagePointerTriggers(db)
  return true
}

export function rebuildThreadMessagesKindConstraint(db: Database.Database): void {
  if (!tableExists(db, 'thread_messages')) {
    repairMissingThreadMessagesTable(db)
    if (threadMessagesAllowsWizardHandoff(db)) return
  }

  dropThreadMessagePointerTriggers(db)
  db.pragma('foreign_keys = OFF')

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
      attachments_json TEXT,
      wizard_phase TEXT CHECK (wizard_phase IS NULL OR wizard_phase IN (${sqlInList(WIZARD_PHASES)})),
      created_at TEXT NOT NULL
    );

    INSERT INTO thread_messages_new SELECT * FROM thread_messages;
    DROP TABLE thread_messages;
    ALTER TABLE thread_messages_new RENAME TO thread_messages;

    CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_created
      ON thread_messages (thread_id, created_at DESC);
  `)

  db.pragma('foreign_keys = ON')
  createThreadMessagePointerTriggers(db)
}
