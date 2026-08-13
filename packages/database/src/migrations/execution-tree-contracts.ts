import type Database from 'better-sqlite3'
import type { Migration } from './v001_042/types.ts'

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  sql: string
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((entry) => entry.name === column)) db.exec(sql)
}

/** Preserve planner intent through Design persistence and Execution materialization. */
export const migration067ExecutionTreeContracts: Migration = {
  version: 67,
  name: 'execution_tree_contracts',
  up(db) {
    addColumnIfMissing(
      db,
      'execution_plan_tasks',
      'required_inputs_json',
      `ALTER TABLE execution_plan_tasks ADD COLUMN required_inputs_json TEXT NOT NULL DEFAULT '[]'`
    )
    addColumnIfMissing(
      db,
      'job_work_items',
      'task_kind',
      `ALTER TABLE job_work_items ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'general-implementation'`
    )
    addColumnIfMissing(
      db,
      'job_work_items',
      'reference_reason',
      `ALTER TABLE job_work_items ADD COLUMN reference_reason TEXT NOT NULL DEFAULT ''`
    )
    addColumnIfMissing(
      db,
      'job_work_items',
      'required_inputs_json',
      `ALTER TABLE job_work_items ADD COLUMN required_inputs_json TEXT NOT NULL DEFAULT '[]'`
    )
    addColumnIfMissing(
      db,
      'job_handoffs',
      'next_attempt_at',
      `ALTER TABLE job_handoffs ADD COLUMN next_attempt_at INTEGER`
    )
    addColumnIfMissing(
      db,
      'job_handoffs',
      'failed_at',
      `ALTER TABLE job_handoffs ADD COLUMN failed_at INTEGER`
    )
    db.exec(`
      UPDATE job_handoffs
      SET next_attempt_at = created_at
      WHERE status = 'pending' AND next_attempt_at IS NULL;

      CREATE TABLE IF NOT EXISTS job_slice_dependencies (
        job_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        from_slice_id TEXT NOT NULL,
        depends_on_slice_id TEXT NOT NULL,
        PRIMARY KEY (job_id, generation, from_slice_id, depends_on_slice_id)
      );

      DROP TABLE IF EXISTS execution_plan_revisions;
    `)
  }
}
