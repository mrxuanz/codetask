import type { SqliteDatabase } from './migrate-core'

export interface CoreDbOrphanCounts {
  readonly draftsWithoutThread: number
  readonly plansWithoutThread: number
  readonly planNodesWithoutPlan: number
  readonly planEdgesWithoutPlan: number
  readonly jobsWithoutThread: number
  readonly tasksWithoutJob: number
  readonly taskAttemptsWithoutTask: number
  readonly verificationAttemptsWithoutJob: number
}

export interface CoreDbValidationReport {
  readonly ok: boolean
  readonly orphans: CoreDbOrphanCounts
  readonly totalOrphans: number
}

function count(db: SqliteDatabase, sql: string): number {
  const row = db.prepare(sql).get() as { c: number }
  return Number(row.c)
}

/**
 * Post-migration / integrity check for core_* tables.
 * Reports orphan FK-style references (missing parents).
 */
export function validateCoreDb(db: SqliteDatabase): CoreDbValidationReport {
  const orphans: CoreDbOrphanCounts = {
    draftsWithoutThread: count(
      db,
      `SELECT COUNT(*) AS c FROM core_drafts d
       LEFT JOIN core_threads t ON t.id = d.thread_id
       WHERE t.id IS NULL`
    ),
    plansWithoutThread: count(
      db,
      `SELECT COUNT(*) AS c FROM core_plans p
       LEFT JOIN core_threads t ON t.id = p.thread_id
       WHERE t.id IS NULL`
    ),
    planNodesWithoutPlan: count(
      db,
      `SELECT COUNT(*) AS c FROM core_plan_nodes n
       LEFT JOIN core_plans p ON p.id = n.plan_id
       WHERE p.id IS NULL`
    ),
    planEdgesWithoutPlan: count(
      db,
      `SELECT COUNT(*) AS c FROM core_plan_edges e
       LEFT JOIN core_plans p ON p.id = e.plan_id
       WHERE p.id IS NULL`
    ),
    jobsWithoutThread: count(
      db,
      `SELECT COUNT(*) AS c FROM core_jobs j
       LEFT JOIN core_threads t ON t.id = j.thread_id
       WHERE t.id IS NULL`
    ),
    tasksWithoutJob: count(
      db,
      `SELECT COUNT(*) AS c FROM core_tasks t
       LEFT JOIN core_jobs j ON j.id = t.job_id
       WHERE j.id IS NULL`
    ),
    taskAttemptsWithoutTask: count(
      db,
      `SELECT COUNT(*) AS c FROM core_task_attempts a
       LEFT JOIN core_tasks t ON t.id = a.task_id
       WHERE t.id IS NULL`
    ),
    verificationAttemptsWithoutJob: count(
      db,
      `SELECT COUNT(*) AS c FROM core_verification_attempts v
       LEFT JOIN core_jobs j ON j.id = v.job_id
       WHERE j.id IS NULL`
    )
  }

  const totalOrphans = Object.values(orphans).reduce((sum, n) => sum + n, 0)
  return {
    ok: totalOrphans === 0,
    orphans,
    totalOrphans
  }
}
