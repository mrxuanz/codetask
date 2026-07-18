import type { Migration } from './types'

function hasColumn(db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } }, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return columns.some((entry) => entry.name === column)
}

export const migration035JobSuspensionRecovery: Migration = {
  version: 35,
  name: 'job_suspension_recovery',
  up(db) {
    if (!hasColumn(db, 'thread_jobs', 'suspension_kind')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN suspension_kind TEXT`)
    }
    if (!hasColumn(db, 'thread_jobs', 'continue_after_pause')) {
      db.exec(
        `ALTER TABLE thread_jobs ADD COLUMN continue_after_pause INTEGER NOT NULL DEFAULT 0`
      )
    }
    if (!hasColumn(db, 'thread_jobs', 'recovery_reason')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN recovery_reason TEXT`)
    }

    // One-time Legacy paused backfill (idempotent: only rows with null suspension_kind).
    db.exec(`
      UPDATE thread_jobs
      SET suspension_kind = 'user_pause'
      WHERE status = 'paused'
        AND suspension_kind IS NULL
        AND last_error LIKE '%"code":"job.paused"%'
    `)

    db.exec(`
      UPDATE thread_jobs
      SET suspension_kind = 'human_dependency'
      WHERE status = 'paused'
        AND suspension_kind IS NULL
        AND id IN (
          SELECT job_id FROM job_tasks
          WHERE recovery_action = 'pause-human'
             OR blocker_kind = 'dependency-human'
        )
    `)
  }
}
