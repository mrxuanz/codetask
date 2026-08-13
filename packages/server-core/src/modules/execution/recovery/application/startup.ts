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
           WHERE status IN ('starting', 'running')`
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
            `UPDATE job_work_items SET state = 'pending', state_revision = state_revision + 1,
             last_error_json = NULL, updated_at = ?
             WHERE state IN ('leased', 'running', 'reported')
               AND EXISTS (
                 SELECT 1 FROM jobs
                 WHERE jobs.id = job_work_items.job_id
                   AND jobs.state IN ('running', 'pausing')
               )`
          )
          .run(now)

        deps.db
          .prepare(
            `UPDATE jobs SET state = 'paused', current_run_id = NULL,
             control_intent = 'none', recovery_reason = 'uncertain_provider_outcome',
             state_revision = state_revision + 1, updated_at = ?
             WHERE state IN ('running', 'pausing') AND EXISTS (
               SELECT 1 FROM work_attempts
               WHERE work_attempts.job_id = jobs.id
                 AND work_attempts.status IN ('starting', 'running')
             )`
          )
          .run(now)

        deps.db
          .prepare(
            `UPDATE jobs SET state = 'paused', current_run_id = NULL,
             control_intent = 'none', recovery_reason = NULL,
             state_revision = state_revision + 1, updated_at = ?
             WHERE state = 'pausing'`
          )
          .run(now)

        deps.db
          .prepare(
            `UPDATE job_work_items SET state = 'cancelled', state_revision = state_revision + 1,
             updated_at = ? WHERE state NOT IN ('succeeded', 'failed', 'cancelled')
             AND EXISTS (
               SELECT 1 FROM jobs
               WHERE jobs.id = job_work_items.job_id AND jobs.state = 'cancelling'
             )`
          )
          .run(now)

        deps.db
          .prepare(
            `UPDATE jobs SET state = 'cancelled', current_run_id = NULL,
             control_intent = 'none', recovery_reason = NULL, terminal_at = ?,
             state_revision = state_revision + 1, updated_at = ?
             WHERE state = 'cancelling'`
          )
          .run(now, now)

        deps.db
          .prepare(
            `UPDATE jobs SET state = 'queued', current_run_id = NULL,
             control_intent = 'none', recovery_reason = NULL,
             state_revision = state_revision + 1, updated_at = ?
             WHERE state = 'running'`
          )
          .run(now)

        deps.db
          .prepare(
            `UPDATE work_attempts SET status = 'interrupted', ended_at = ?
             WHERE status IN ('starting', 'running')`
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

        deps.db
          .prepare(
            `UPDATE execution_queue_entries SET status = 'removed', removed_at = ?
             WHERE status = 'claimed' AND EXISTS (
               SELECT 1 FROM jobs
               WHERE jobs.id = execution_queue_entries.job_id
                 AND jobs.execution_generation = execution_queue_entries.generation
                 AND jobs.state IN ('paused', 'cancelled')
             )`
          )
          .run(now)
      })
      tx()
    }
  }
}
