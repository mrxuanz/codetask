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

export const migration014RetentionLayer: Migration = {
  version: 14,
  name: 'retention_layer',
  up(db) {
    if (!tableExists(db, 'job_artifacts')) {
      db.exec(`
        CREATE TABLE job_artifacts (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES thread_jobs(id) ON DELETE CASCADE,
          task_id TEXT,
          kind TEXT NOT NULL,
          tier TEXT NOT NULL DEFAULT 'working',
          content_hash TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          storage TEXT NOT NULL CHECK (storage IN ('inline', 'file')),
          content_inline TEXT,
          content_path TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_job_artifacts_job_expires
          ON job_artifacts (job_id, expires_at);

        CREATE INDEX IF NOT EXISTS idx_job_artifacts_job_task_kind
          ON job_artifacts (job_id, task_id, kind);
      `)
    }

    if (!tableExists(db, 'job_counters')) {
      db.exec(`
        CREATE TABLE job_counters (
          job_id TEXT NOT NULL REFERENCES thread_jobs(id) ON DELETE CASCADE,
          counter_key TEXT NOT NULL,
          value INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (job_id, counter_key)
        );

        CREATE INDEX IF NOT EXISTS idx_job_counters_job
          ON job_counters (job_id);
      `)
    }

    if (!columnExists(db, 'thread_jobs', 'terminal_at')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN terminal_at INTEGER`)
    }

    if (!columnExists(db, 'job_tasks', 'evidence_artifact_id')) {
      db.exec(`ALTER TABLE job_tasks ADD COLUMN evidence_artifact_id TEXT`)
    }
    if (!columnExists(db, 'job_tasks', 'evidence_summary')) {
      db.exec(`ALTER TABLE job_tasks ADD COLUMN evidence_summary TEXT`)
    }
    if (!columnExists(db, 'job_tasks', 'blocker_kind')) {
      db.exec(`ALTER TABLE job_tasks ADD COLUMN blocker_kind TEXT`)
    }
    if (!columnExists(db, 'job_tasks', 'recovery_action')) {
      db.exec(`ALTER TABLE job_tasks ADD COLUMN recovery_action TEXT`)
    }

    db.exec(`
      UPDATE thread_jobs
      SET terminal_at = updated_at
      WHERE terminal_at IS NULL
        AND status IN ('completed', 'failed', 'cancelled')
    `)
  }
}
