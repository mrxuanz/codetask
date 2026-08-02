import type Database from 'better-sqlite3'
import { nowMs } from '../../shared.ts'

export function createRecoverWorkService(deps: { db: Database.Database }) {
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

export function createReconcileInterruptedRunService(deps: { db: Database.Database }) {
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

export function createStartupReconcileService(deps: { db: Database.Database }) {
  return {
    run(): void {
      const now = nowMs()
      deps.db
        .prepare(
          `UPDATE execution_runs SET status = 'interrupted', updated_at = ?
           WHERE status = 'active' AND lease_expires_at <= ?`
        )
        .run(now, now)

      deps.db
        .prepare(
          `UPDATE execution_pool_slots SET status = 'free', run_id = NULL, lease_owner = NULL,
           lease_expires_at = NULL, released_at = ?
           WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
        )
        .run(now, now)

      deps.db
        .prepare(
          `UPDATE workspace_leases SET status = 'expired', released_at = ?
           WHERE status = 'active' AND lease_expires_at <= ?`
        )
        .run(now, now)

      deps.db
        .prepare(
          `UPDATE work_attempts SET status = 'interrupted', ended_at = ? WHERE status = 'running'`
        )
        .run(now)

      deps.db
        .prepare(
          `UPDATE jobs SET state = 'paused', recovery_reason = 'uncertain_provider_outcome', updated_at = ?
           WHERE id IN (
             SELECT DISTINCT job_id FROM work_attempts WHERE status = 'interrupted'
           ) AND state = 'running'`
        )
        .run(now)

      deps.db
        .prepare(
          `UPDATE jobs SET state = 'queued', updated_at = ?
           WHERE state = 'running'
             AND id NOT IN (SELECT DISTINCT job_id FROM work_attempts WHERE status = 'interrupted')`
        )
        .run(now)
    }
  }
}
