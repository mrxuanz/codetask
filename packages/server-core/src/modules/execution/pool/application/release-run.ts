import type Database from 'better-sqlite3'
import { EXECUTION_POOL, EXECUTION_SLOT, nowMs } from '../../shared.ts'
import { PoolRepository } from '../infrastructure/pool-repository.ts'
import { wakeScheduler } from '../../queue/application/wake-scheduler.ts'

export type ReleaseRunService = {
  releaseRun(runId: string, reason?: string): void
}

export type HeartbeatRunService = {
  heartbeat(runId: string): void
}

export type DrainPoolService = {
  setDraining(value: boolean): void
  isDraining(): boolean
  drain(): void
}

export type ReconcilePoolService = {
  reconcile(): void
}

export function createReleaseRunService(deps: {
  db: Database.Database
  pool: PoolRepository
}): ReleaseRunService {
  return {
    releaseRun(runId: string, reason = 'completed'): void {
      const now = nowMs()
      const tx = deps.db.transaction(() => {
        deps.db
          .prepare(
            `UPDATE execution_runs SET status = 'released', released_at = ?, release_reason = ?, updated_at = ?
             WHERE id = ? AND status IN ('active', 'stopping')`
          )
          .run(now, reason, now, runId)

        deps.db
          .prepare(
            `UPDATE execution_pool_slots SET
              status = 'free', run_id = NULL, lease_owner = NULL, lease_expires_at = NULL, released_at = ?
             WHERE pool = ? AND slot_number = ? AND run_id = ?`
          )
          .run(now, EXECUTION_POOL, EXECUTION_SLOT, runId)

        deps.db
          .prepare(
            `UPDATE workspace_leases SET status = 'released', released_at = ?
             WHERE run_id = ? AND status = 'active'`
          )
          .run(now, runId)
      })
      tx()
      wakeScheduler()
    }
  }
}

export function createHeartbeatRunService(deps: {
  pool: PoolRepository
  leaseOwner: string
}): HeartbeatRunService {
  return {
    heartbeat(runId: string): void {
      deps.pool.heartbeat(runId, deps.leaseOwner, nowMs())
    }
  }
}

export function createDrainPoolService(deps: { db: Database.Database }): DrainPoolService {
  let draining = false
  return {
    setDraining(value: boolean): void {
      draining = value
    },
    isDraining(): boolean {
      return draining
    },
    drain(): void {
      draining = true
      const now = nowMs()
      deps.db
        .prepare(
          `UPDATE execution_runs SET status = 'released', released_at = ?, release_reason = 'drain'
           WHERE status = 'active'`
        )
        .run(now)
      deps.db
        .prepare(
          `UPDATE execution_pool_slots SET status = 'free', run_id = NULL, released_at = ?
           WHERE pool = ? AND status = 'claimed'`
        )
        .run(now, EXECUTION_POOL)
      deps.db
        .prepare(
          `UPDATE workspace_leases SET status = 'released', released_at = ? WHERE status = 'active'`
        )
        .run(now)
    }
  }
}

export function createReconcilePoolService(deps: { pool: PoolRepository }): ReconcilePoolService {
  return {
    reconcile(): void {
      deps.pool.expireStale(nowMs())
    }
  }
}
