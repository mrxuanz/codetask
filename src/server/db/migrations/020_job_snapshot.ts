import type { Migration } from './types'

export const migration020JobSnapshot: Migration = {
  version: 20,
  name: 'job_snapshot',
  up(db) {
    const cols = db.prepare(`PRAGMA table_info(thread_jobs)`).all() as Array<{ name: string }>
    const names = new Set(cols.map((col) => col.name))
    if (!names.has('design_session_id')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN design_session_id TEXT`)
    }
    if (!names.has('snapshot_draft_revision')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN snapshot_draft_revision INTEGER`)
    }
    if (!names.has('snapshot_plan_revision')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN snapshot_plan_revision INTEGER`)
    }
    if (!names.has('snapshot_manifest_revision')) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN snapshot_manifest_revision INTEGER`)
    }
  }
}
