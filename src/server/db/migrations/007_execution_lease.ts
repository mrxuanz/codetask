import type { Migration } from './types'

function columnExists(
  db: import('better-sqlite3').Database,
  table: string,
  column: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((col) => col.name === column)
}

export const migration007ExecutionLease: Migration = {
  version: 7,
  name: 'execution_lease',
  up(db) {
    if (!columnExists(db, 'thread_jobs', 'execution_lease_owner')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN execution_lease_owner TEXT`)
    }
    if (!columnExists(db, 'thread_jobs', 'execution_lease_expires_at')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN execution_lease_expires_at INTEGER`)
    }
  }
}
