import type { Migration } from './types'
import {
  JOB_STATUSES,
  PLAN_PHASES,
  PLAN_STATUSES,
  TASK_PHASES,
  TASK_STATUSES,
  sqlInList
} from '../constraints'
import {
  createThreadPlanPointerTriggers,
  dropThreadPlanPointerTriggers
} from './thread-plan-pointer-triggers'

function recreateThreadJobTriggers(db: import('better-sqlite3').Database): void {
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

    DROP TRIGGER IF EXISTS thread_jobs_clear_active_plan;
    CREATE TRIGGER thread_jobs_clear_active_plan
    AFTER DELETE ON thread_jobs
    BEGIN
      UPDATE threads
      SET active_plan_id = NULL
      WHERE active_plan_id = OLD.id;
    END;
  `)
}

function threadJobsCheckIncludesPausing(db: import('better-sqlite3').Database): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'thread_jobs'`)
    .get() as { sql?: string } | undefined
  return row?.sql?.includes("'pausing'") ?? false
}

export const migration024JobPausingStatus: Migration = {
  version: 24,
  name: 'job_pausing_status',
  up(db) {
    if (threadJobsCheckIncludesPausing(db)) return

    db.pragma('foreign_keys = OFF')

    const tx = db.transaction(() => {
      dropThreadPlanPointerTriggers(db)
      db.exec(`
        CREATE TABLE thread_jobs_new (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          username TEXT NOT NULL,
          draft_message_id TEXT NOT NULL REFERENCES thread_messages(id) ON DELETE RESTRICT,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN (${sqlInList(JOB_STATUSES)})),
          workspace_path TEXT NOT NULL,
          plan_phase TEXT NOT NULL DEFAULT 'idle' CHECK (plan_phase IN (${sqlInList(PLAN_PHASES)})),
          plan_status TEXT NOT NULL DEFAULT 'pending' CHECK (plan_status IN (${sqlInList(PLAN_STATUSES)})),
          plan_contexts_registered INTEGER NOT NULL DEFAULT 0,
          plan_contexts_total INTEGER NOT NULL DEFAULT 0,
          plan_message TEXT,
          plan_counts_json TEXT NOT NULL DEFAULT '{}',
          task_phase TEXT NOT NULL DEFAULT 'idle' CHECK (task_phase IN (${sqlInList(TASK_PHASES)})),
          task_status TEXT NOT NULL DEFAULT 'pending' CHECK (task_status IN (${sqlInList(TASK_STATUSES)})),
          task_current_index INTEGER NOT NULL DEFAULT 0,
          task_total INTEGER NOT NULL DEFAULT 0,
          task_current_task_id TEXT,
          task_message TEXT,
          task_meta_json TEXT NOT NULL DEFAULT '{}',
          last_error TEXT,
          draft_confirmed_at INTEGER,
          plan_confirmed_at INTEGER,
          reference_manifest_json TEXT,
          design_session_id TEXT,
          snapshot_draft_revision INTEGER,
          snapshot_plan_revision INTEGER,
          snapshot_manifest_revision INTEGER,
          execution_lease_owner TEXT,
          execution_lease_expires_at INTEGER,
          terminal_at INTEGER,
          active_run_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (thread_id, draft_message_id)
        );

        INSERT INTO thread_jobs_new (
          id, thread_id, username, draft_message_id, title, summary, status, workspace_path,
          plan_phase, plan_status, plan_contexts_registered, plan_contexts_total,
          plan_message, plan_counts_json,
          task_phase, task_status, task_current_index, task_total,
          task_current_task_id, task_message, task_meta_json,
          last_error, draft_confirmed_at, plan_confirmed_at,
          reference_manifest_json, design_session_id,
          snapshot_draft_revision, snapshot_plan_revision, snapshot_manifest_revision,
          execution_lease_owner, execution_lease_expires_at, terminal_at, active_run_id,
          created_at, updated_at
        )
        SELECT
          id, thread_id, username, draft_message_id, title, summary, status, workspace_path,
          plan_phase, plan_status, plan_contexts_registered, plan_contexts_total,
          plan_message, plan_counts_json,
          task_phase, task_status, task_current_index, task_total,
          task_current_task_id, task_message, task_meta_json,
          last_error, draft_confirmed_at, plan_confirmed_at,
          reference_manifest_json, design_session_id,
          snapshot_draft_revision, snapshot_plan_revision, snapshot_manifest_revision,
          execution_lease_owner, execution_lease_expires_at, terminal_at, active_run_id,
          created_at, updated_at
        FROM thread_jobs;

        DROP TABLE thread_jobs;
        ALTER TABLE thread_jobs_new RENAME TO thread_jobs;

        CREATE INDEX IF NOT EXISTS idx_thread_jobs_thread_updated
          ON thread_jobs (thread_id, updated_at DESC);
      `)

      recreateThreadJobTriggers(db)
      createThreadPlanPointerTriggers(db)
    })

    tx()
    db.pragma('foreign_keys = ON')
  }
}
