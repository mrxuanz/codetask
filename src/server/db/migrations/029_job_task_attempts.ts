import type { Migration } from './types'

function tableExists(db: import('better-sqlite3').Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return row?.name === table
}

/**
 * FIX-PLAN F3-B (§8.3): minimal task-attempt / checkpoint ledger for crash recovery.
 *
 * New migration version (never modifies an applied migration). Creates `job_task_attempts` with:
 *   - FKs to the owning Job and (nullable) workload run
 *   - UNIQUE(job_id, task_id, attempt_no) — one row per attempt of a task
 *   - UNIQUE(idempotency_key)             — stable, per-attempt idempotency for provider calls
 *   - status in (starting|running|completed|interrupted|failed)
 */
export const migration029JobTaskAttempts: Migration = {
  version: 29,
  name: 'job_task_attempts',
  up(db) {
    if (tableExists(db, 'job_task_attempts')) return

    db.exec(`
      CREATE TABLE job_task_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES thread_jobs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        run_id TEXT REFERENCES workload_runs(id) ON DELETE SET NULL,
        attempt_no INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('starting', 'running', 'completed', 'interrupted', 'failed')
        ),
        result_hash TEXT,
        error_json TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE UNIQUE INDEX idx_job_task_attempts_job_task_no
        ON job_task_attempts (job_id, task_id, attempt_no);
      CREATE UNIQUE INDEX idx_job_task_attempts_idempotency
        ON job_task_attempts (idempotency_key);
      CREATE INDEX idx_job_task_attempts_status
        ON job_task_attempts (status);
    `)
  }
}
