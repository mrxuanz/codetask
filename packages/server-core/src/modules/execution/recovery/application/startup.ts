import type Database from 'better-sqlite3'
import { nowMs } from '../../shared.ts'

export type RecoverWorkService = {
  markInterruptedAttempts(now?: number): number
}

export type ReconcileInterruptedRunService = {
  reconcile(): void
}

export type StartupReconcileService = {
  run(): void
}

export function createRecoverWorkService(deps: { db: Database.Database }): RecoverWorkService {
  return {
    markInterruptedAttempts(now = nowMs()): number {
      const result = deps.db
        .prepare(
          `UPDATE work_attempts SET status = 'interrupted', ended_at = ?
           WHERE status = 'running'`
        )
        .run(now)
      return result.changes
    }
  }
}

export { createInjectRepairWorkService } from './inject-repair-work.ts'

export function createReconcileInterruptedRunService(deps: {
  db: Database.Database
}): ReconcileInterruptedRunService {
  return {
    reconcile(): void {
      const now = nowMs()
      deps.db
        .prepare(
          `UPDATE execution_runs SET status = 'interrupted', updated_at = ?
           WHERE status = 'active' AND lease_expires_at <= ?`
        )
        .run(now, now)
    }
  }
}

export function createStartupReconcileService(deps: {
  db: Database.Database
}): StartupReconcileService {
  return {
    run(): void {
      const now = nowMs()
      const tx = deps.db.transaction(() => {
        deps.db
          .prepare(
            `UPDATE execution_runs SET status = 'interrupted', updated_at = ?
             WHERE status = 'active'`
          )
          .run(now)

        deps.db
          .prepare(
            `UPDATE execution_pool_slots SET status = 'free', run_id = NULL, lease_owner = NULL,
             lease_expires_at = NULL, released_at = ? WHERE status = 'claimed'`
          )
          .run(now)

        deps.db
          .prepare(
            `UPDATE workspace_leases SET status = 'expired', released_at = ?
             WHERE status = 'active'`
          )
          .run(now)

        deps.db
          .prepare(
            `UPDATE work_attempts SET status = 'interrupted', ended_at = ? WHERE status = 'running'`
          )
          .run(now)

        deps.db
          .prepare(
            `UPDATE jobs SET state = 'paused', current_run_id = NULL,
             recovery_reason = 'uncertain_provider_outcome', updated_at = ?
             WHERE id IN (
               SELECT DISTINCT job_id FROM work_attempts WHERE status = 'interrupted'
             ) AND state = 'running'`
          )
          .run(now)

        deps.db
          .prepare(
            `UPDATE jobs SET state = 'queued', current_run_id = NULL, updated_at = ?
             WHERE state = 'running'`
          )
          .run(now)

        deps.db
          .prepare(
            `UPDATE execution_queue_entries SET status = 'queued', claimed_at = NULL, removed_at = NULL
             WHERE status = 'claimed' AND EXISTS (
               SELECT 1 FROM jobs
               WHERE jobs.id = execution_queue_entries.job_id
                 AND jobs.execution_generation = execution_queue_entries.generation
                 AND jobs.state = 'queued'
             )`
          )
          .run()
      })
      tx()
    }
  }
}
