import type { Migration } from './types'

function tableExists(db: import('better-sqlite3').Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return Boolean(row)
}

export const migration013DropJobEvents: Migration = {
  version: 13,
  name: 'drop_job_events',
  up(db) {
    if (tableExists(db, 'job_events')) {
      db.exec('DROP TABLE job_events')
    }
  }
}
