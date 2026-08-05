import type { Migration } from './types.ts'

function columnExists(
  db: import('better-sqlite3').Database,
  table: string,
  column: string
): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return columns.some((entry) => entry.name === column)
}

export const migration042ExecutionProfile: Migration = {
  version: 42,
  name: 'execution_profile',
  up(db) {
    if (!columnExists(db, 'thread_jobs', 'execution_profile_json')) {
      db.exec('ALTER TABLE thread_jobs ADD COLUMN execution_profile_json TEXT')
    }
  }
}
