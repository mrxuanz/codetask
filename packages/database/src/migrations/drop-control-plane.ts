import type Database from 'better-sqlite3'

export type ControlPlaneDropMigration = {
  version: number
  name: string
  up: (db: Database.Database) => void
}

/**
 * Drop V3/control-plane tables after Execution cutover (02 §21).
 * Historical migrations 027/028 remain for old DB upgrade paths; this removes
 * the tables so they are not a second data source.
 */
export const migration047DropControlPlaneTables: ControlPlaneDropMigration = {
  version: 47,
  name: 'drop_control_plane_tables',
  up(db) {
    const tables = [
      'control_evidence_blobs',
      'control_job_failures',
      'control_command_dedup',
      'control_outbox_events',
      'control_resource_slots',
      'control_plan_tasks',
      'control_plan_slices',
      'control_plan_milestones',
      'control_plan_revisions',
      'control_verifications',
      'control_task_attempts',
      'control_job_tasks',
      'control_runtime_instances',
      'control_job_runs',
      'control_jobs',
      'control_schema_meta',
      // Corrective leftovers from 028 if rename mid-flight left them
      'control_job_runs_new',
      'control_task_attempts_new',
      'control_outbox_events_new',
      'control_command_dedup_new',
      'control_verifications_new',
      'control_schema_meta_new'
    ]
    for (const table of tables) {
      db.exec(`DROP TABLE IF EXISTS ${table}`)
    }
  }
}
