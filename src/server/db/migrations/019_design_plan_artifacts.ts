import type { Migration } from './types'

export const migration019DesignPlanArtifacts: Migration = {
  version: 19,
  name: 'design_plan_artifacts',
  up(db) {
    const cols = db.prepare(`PRAGMA table_info(design_sessions)`).all() as Array<{ name: string }>
    const names = new Set(cols.map((col) => col.name))
    if (!names.has('plan_artifact_id')) {
      db.exec(`ALTER TABLE design_sessions ADD COLUMN plan_artifact_id TEXT`)
    }
    if (!names.has('plan_summary_json')) {
      db.exec(`ALTER TABLE design_sessions ADD COLUMN plan_summary_json TEXT`)
    }
    if (!names.has('plan_artifact_path')) {
      db.exec(`ALTER TABLE design_sessions ADD COLUMN plan_artifact_path TEXT`)
    }
  }
}
