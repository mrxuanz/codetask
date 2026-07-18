import type { Migration } from './types'

function tableExists(db: import('better-sqlite3').Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return Boolean(row)
}

function columnExists(db: import('better-sqlite3').Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((row) => row.name === column)
}

/**
 * R5: durable deletion phase state machine — freeze targets at request creation and resume by phase.
 */
export const migration031DeletionRequestPhases: Migration = {
  version: 31,
  name: 'deletion_request_phases',
  up(db) {
    if (!tableExists(db, 'deletion_requests')) return

    if (!columnExists(db, 'deletion_requests', 'phase')) {
      db.exec(`ALTER TABLE deletion_requests ADD COLUMN phase TEXT NOT NULL DEFAULT 'requested'`)
    }
    if (!columnExists(db, 'deletion_requests', 'thread_id')) {
      db.exec(`ALTER TABLE deletion_requests ADD COLUMN thread_id TEXT`)
    }
    if (!columnExists(db, 'deletion_requests', 'project_id')) {
      db.exec(`ALTER TABLE deletion_requests ADD COLUMN project_id TEXT`)
    }
    if (!columnExists(db, 'deletion_requests', 'workspace_path')) {
      db.exec(`ALTER TABLE deletion_requests ADD COLUMN workspace_path TEXT`)
    }
    if (!columnExists(db, 'deletion_requests', 'cleanup_targets_json')) {
      db.exec(`ALTER TABLE deletion_requests ADD COLUMN cleanup_targets_json TEXT`)
    }
    if (!columnExists(db, 'deletion_requests', 'retry_count')) {
      db.exec(`ALTER TABLE deletion_requests ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`)
    }
    if (!columnExists(db, 'deletion_requests', 'last_error')) {
      db.exec(`ALTER TABLE deletion_requests ADD COLUMN last_error TEXT`)
    }

    db.exec(`
      UPDATE deletion_requests
      SET phase = CASE
        WHEN status = 'completed' AND filesystem_cleanup_json IS NOT NULL
             AND trim(filesystem_cleanup_json) != ''
             AND trim(filesystem_cleanup_json) != '[]'
          THEN 'database_deleted'
        WHEN status = 'completed' THEN 'completed'
        WHEN status = 'failed' THEN phase
        WHEN status = 'pending' THEN 'requested'
        WHEN status = 'draining' THEN 'draining'
        WHEN status = 'deleting' THEN 'runtime_closed'
        ELSE COALESCE(phase, 'requested')
      END
      WHERE phase IS NULL OR phase = '' OR phase = 'requested'
    `)

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_deletion_requests_phase
        ON deletion_requests (phase)
    `)
  }
}
