import type { Migration } from './types'

export const migration001BaselineTables: Migration = {
  version: 1,
  name: 'baseline_tables',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        session_token TEXT,
        session_expires_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        title TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_projects_username_updated
        ON projects (username, updated_at DESC);

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        core_code TEXT NOT NULL,
        runtime_status TEXT NOT NULL,
        runtime_session_id TEXT,
        core_runtime_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_threads_user_updated
        ON threads (username, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_threads_project_updated
        ON threads (project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS thread_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        core_code TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        runtime_session_id TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_created
        ON thread_messages (thread_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS thread_jobs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        username TEXT NOT NULL,
        draft_message_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        abilities_json TEXT NOT NULL DEFAULT '[]',
        plan_json TEXT,
        plan_progress_json TEXT NOT NULL DEFAULT '{}',
        task_progress_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_thread_jobs_thread_updated
        ON thread_jobs (thread_id, updated_at DESC);
    `)

    const messageCols = db.prepare(`PRAGMA table_info(thread_messages)`).all() as Array<{
      name: string
    }>
    if (!messageCols.some((col) => col.name === 'attachments_json')) {
      db.exec(`ALTER TABLE thread_messages ADD COLUMN attachments_json TEXT`)
    }

    const threadCols = db.prepare(`PRAGMA table_info(threads)`).all() as Array<{ name: string }>
    if (!threadCols.some((col) => col.name === 'title_source')) {
      db.exec(`ALTER TABLE threads ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto'`)
    }
    if (!threadCols.some((col) => col.name === 'active_draft_id')) {
      db.exec(`ALTER TABLE threads ADD COLUMN active_draft_id TEXT`)
    }
    if (!threadCols.some((col) => col.name === 'active_plan_id')) {
      db.exec(`ALTER TABLE threads ADD COLUMN active_plan_id TEXT`)
    }
    if (!threadCols.some((col) => col.name === 'wizard_phase')) {
      db.exec(`ALTER TABLE threads ADD COLUMN wizard_phase TEXT NOT NULL DEFAULT 'collect'`)
      db.exec(`
        UPDATE threads
        SET wizard_phase = 'plan_edit'
        WHERE active_plan_id IS NOT NULL
      `)
      db.exec(`
        UPDATE threads
        SET wizard_phase = 'draft_review'
        WHERE wizard_phase = 'collect'
          AND active_draft_id IS NOT NULL
          AND active_plan_id IS NULL
      `)
    }
    if (!threadCols.some((col) => col.name === 'thread_kind')) {
      db.exec(`ALTER TABLE threads ADD COLUMN thread_kind TEXT NOT NULL DEFAULT 'chat'`)
      db.exec(`
        UPDATE threads
        SET thread_kind = 'create_task'
        WHERE active_draft_id IS NOT NULL
           OR active_plan_id IS NOT NULL
           OR id IN (SELECT DISTINCT thread_id FROM thread_messages WHERE kind = 'task-launch-draft')
           OR id IN (SELECT DISTINCT thread_id FROM thread_messages WHERE wizard_phase IS NOT NULL)
      `)
    }

    const messageCols2 = db.prepare(`PRAGMA table_info(thread_messages)`).all() as Array<{
      name: string
    }>
    if (!messageCols2.some((col) => col.name === 'wizard_phase')) {
      db.exec(`ALTER TABLE thread_messages ADD COLUMN wizard_phase TEXT`)
    }

    const jobCols = db.prepare(`PRAGMA table_info(thread_jobs)`).all() as Array<{ name: string }>
    if (!jobCols.some((col) => col.name === 'summary')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN summary TEXT NOT NULL DEFAULT ''`)
    }
    if (!jobCols.some((col) => col.name === 'draft_confirmed_at')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN draft_confirmed_at INTEGER`)
    }
    if (!jobCols.some((col) => col.name === 'plan_confirmed_at')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN plan_confirmed_at INTEGER`)
    }

    db.exec(`
      UPDATE thread_jobs
      SET status = 'plan_editing'
      WHERE status = 'plan_ready'
        AND json_extract(task_progress_json, '$.phase') = 'idle'
    `)
    db.exec(`
      UPDATE thread_jobs
      SET status = 'pending', plan_confirmed_at = COALESCE(plan_confirmed_at, updated_at)
      WHERE status = 'plan_ready'
        AND json_extract(task_progress_json, '$.phase') != 'idle'
    `)
  }
}
