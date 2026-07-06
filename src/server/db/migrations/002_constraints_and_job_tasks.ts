import type { Migration } from './types'
import {
  JOB_STATUSES,
  JOB_TASK_STATUSES,
  MESSAGE_KINDS,
  MESSAGE_ROLES,
  RUNTIME_STATUSES,
  TASK_PHASES,
  TASK_STATUSES,
  THREAD_KINDS,
  THREAD_STATUSES,
  TITLE_SOURCES,
  WIZARD_PHASES,
  sqlInList
} from '../constraints'

function tableExists(db: import('better-sqlite3').Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

function migrateTaskProgressFromJson(db: import('better-sqlite3').Database): void {
  const jobs = db
    .prepare(
      `SELECT id, task_progress_json FROM thread_jobs WHERE task_progress_json IS NOT NULL AND task_progress_json != ''`
    )
    .all() as Array<{ id: string; task_progress_json: string }>

  const updateJob = db.prepare(`
    UPDATE thread_jobs SET
      task_phase = ?,
      task_status = ?,
      task_current_index = ?,
      task_total = ?,
      task_current_task_id = ?,
      task_message = ?,
      task_meta_json = ?
    WHERE id = ?
  `)

  const insertTask = db.prepare(`
    INSERT OR REPLACE INTO job_tasks (
      job_id, task_id, title, sort_order, status,
      ability_code, execution_status, evidence_status, error_message, core_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const job of jobs) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(job.task_progress_json) as Record<string, unknown>
    } catch {
      continue
    }

    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
    const meta = {
      slices: parsed.slices ?? undefined,
      milestones: parsed.milestones ?? undefined,
      repairGenerations: parsed.repairGenerations ?? undefined
    }

    updateJob.run(
      typeof parsed.phase === 'string' ? parsed.phase : 'idle',
      typeof parsed.status === 'string' ? parsed.status : 'pending',
      typeof parsed.currentIndex === 'number' ? parsed.currentIndex : 0,
      typeof parsed.total === 'number' ? parsed.total : tasks.length,
      typeof parsed.currentTaskId === 'string' ? parsed.currentTaskId : null,
      typeof parsed.message === 'string' ? parsed.message : null,
      JSON.stringify(meta),
      job.id
    )

    tasks.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') return
      const task = raw as Record<string, unknown>
      const taskId = typeof task.id === 'string' ? task.id : `legacy-${index}`
      insertTask.run(
        job.id,
        taskId,
        typeof task.title === 'string' ? task.title : taskId,
        index,
        typeof task.status === 'string' ? task.status : 'queued',
        typeof task.abilityCode === 'string' ? task.abilityCode : null,
        typeof task.executionStatus === 'string' ? task.executionStatus : null,
        typeof task.evidenceStatus === 'string' ? task.evidenceStatus : null,
        typeof task.errorMessage === 'string' ? task.errorMessage : null,
        typeof task.coreCode === 'string' ? task.coreCode : null
      )
    })
  }
}

export const migration002ConstraintsAndJobTasks: Migration = {
  version: 2,
  name: 'constraints_and_job_tasks',
  up(db) {
    if (tableExists(db, 'job_tasks')) return

    db.pragma('foreign_keys = OFF')

    const tx = db.transaction(() => {
      db.exec(`
        DELETE FROM projects
        WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM projects GROUP BY username, workspace_root
        );
      `)

      db.exec(`
        DELETE FROM thread_jobs
        WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM thread_jobs GROUP BY thread_id, draft_message_id
        );
      `)

      db.exec(`
        CREATE TABLE projects_new (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          title TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (username, workspace_root)
        );

        INSERT INTO projects_new SELECT * FROM projects;
        DROP TABLE projects;
        ALTER TABLE projects_new RENAME TO projects;

        CREATE INDEX IF NOT EXISTS idx_projects_username_updated
          ON projects (username, updated_at DESC);
      `)

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
          abilities_json TEXT NOT NULL DEFAULT '[]',
          plan_json TEXT,
          plan_progress_json TEXT NOT NULL DEFAULT '{}',
          task_progress_json TEXT NOT NULL DEFAULT '{}',
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
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (thread_id, draft_message_id)
        );

        INSERT INTO thread_jobs_new (
          id, thread_id, username, draft_message_id, title, summary, status,
          workspace_path, abilities_json, plan_json, plan_progress_json, task_progress_json,
          last_error, draft_confirmed_at, plan_confirmed_at, created_at, updated_at
        )
        SELECT
          id, thread_id, username, draft_message_id, title, summary, status,
          workspace_path, abilities_json, plan_json, plan_progress_json, task_progress_json,
          last_error, draft_confirmed_at, plan_confirmed_at, created_at, updated_at
        FROM thread_jobs;

        DROP TABLE thread_jobs;
        ALTER TABLE thread_jobs_new RENAME TO thread_jobs;

        CREATE INDEX IF NOT EXISTS idx_thread_jobs_thread_updated
          ON thread_jobs (thread_id, updated_at DESC);
      `)

      db.exec(`
        CREATE TABLE job_tasks (
          job_id TEXT NOT NULL REFERENCES thread_jobs(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          title TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN (${sqlInList(JOB_TASK_STATUSES)})),
          ability_code TEXT,
          execution_status TEXT,
          evidence_status TEXT,
          error_message TEXT,
          core_code TEXT,
          PRIMARY KEY (job_id, task_id)
        );

        CREATE INDEX IF NOT EXISTS idx_job_tasks_job_order
          ON job_tasks (job_id, sort_order);
      `)

      migrateTaskProgressFromJson(db)

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
      `)
    })

    tx()
    db.pragma('foreign_keys = ON')
  }
}
