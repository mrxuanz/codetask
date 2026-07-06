import type { Migration } from './types'

function columnExists(
  db: import('better-sqlite3').Database,
  table: string,
  column: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((col) => col.name === column)
}

export const migration012TaskEvidenceJson: Migration = {
  version: 12,
  name: 'task_evidence_json',
  up(db) {
    if (!columnExists(db, 'job_tasks', 'evidence_json')) {
      db.exec(`ALTER TABLE job_tasks ADD COLUMN evidence_json TEXT`)
    }
  }
}
