import type Database from 'better-sqlite3'

export type HostShellDropMigration = {
  version: number
  name: string
  up: (db: Database.Database) => void
}

/**
 * Drop host-side legacy job/workload shell tables after Design/Execution cutover.
 * Historical migrations 002–039 remain for upgrade paths; live code no longer reads these.
 */
export const migration059DropLegacyJobShellTables: HostShellDropMigration = {
  version: 59,
  name: 'drop_legacy_job_shell_tables',
  up(db) {
    // Children / dependents first (FK-safe when foreign_keys=ON).
    const tables = [
      'job_task_attempts',
      'workload_slots',
      'workload_runs',
      'job_tasks',
      'job_abilities',
      'job_plan_tasks',
      'job_plan_slices',
      'job_plan_milestones',
      'design_runs'
    ]
    for (const table of tables) {
      db.exec(`DROP TABLE IF EXISTS ${table}`)
    }
  }
}
