import type { Migration } from './types'

function columnExists(
  db: import('better-sqlite3').Database,
  table: string,
  column: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((col) => col.name === column)
}

export const migration009ReferenceManifest: Migration = {
  version: 9,
  name: 'reference_manifest',
  up(db) {
    if (!columnExists(db, 'thread_jobs', 'reference_manifest_json')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN reference_manifest_json TEXT`)
    }
  }
}
