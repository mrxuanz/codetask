import type { Migration } from './types'

export const migration025RuntimeBytes: Migration = {
  version: 25,
  name: 'runtime_bytes',
  up(db) {
    const columnExists = db
      .prepare(
        `SELECT 1 FROM pragma_table_info('thread_jobs') WHERE name = 'runtime_bytes'`
      )
      .get()

    if (!columnExists) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN runtime_bytes INTEGER NOT NULL DEFAULT 0`)
    }
  }
}
