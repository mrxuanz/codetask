import type Database from 'better-sqlite3'
import type { ExecutionRun } from '../domain/execution-run.ts'
import { EXECUTION_POOL, EXECUTION_SLOT, LEASE_TTL_MS } from '../../shared.ts'

function mapRun(row: Record<string, unknown>): ExecutionRun {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    generation: row.generation as number,
    status: row.status as ExecutionRun['status'],
    leaseOwner: row.lease_owner as string,
    leaseExpiresAt: row.lease_expires_at as number,
    fencingToken: row.fencing_token as number,
    runtimeRefJson: (row.runtime_ref_json as string | null) ?? null,
    startedAt: row.started_at as number,
    updatedAt: row.updated_at as number,
    releasedAt: (row.released_at as number | null) ?? null,
    releaseReason: (row.release_reason as string | null) ?? null
  }
}

export class PoolRepository {
  constructor(private readonly db: Database.Database) {}

  getRun(runId: string): ExecutionRun | null {
    const row = this.db.prepare(`SELECT * FROM execution_runs WHERE id = ?`).get(runId)
    return row ? mapRun(row as Record<string, unknown>) : null
  }

  getActiveRunForJob(jobId: string): ExecutionRun | null {
    const row = this.db
      .prepare(
        `SELECT * FROM execution_runs WHERE job_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1`
      )
      .get(jobId) as Record<string, unknown> | undefined
    return row ? mapRun(row) : null
  }

  isSlotFree(): boolean {
    const row = this.db
      .prepare(
        `SELECT status FROM execution_pool_slots WHERE pool = ? AND slot_number = ?`
      )
      .get(EXECUTION_POOL, EXECUTION_SLOT) as { status: string } | undefined
    return row?.status === 'free'
  }

  hasActiveWorkspaceLease(canonicalRoot: string): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM workspace_leases
         WHERE canonical_workspace_root = ? AND status = 'active' AND lease_expires_at > ?`
      )
      .get(canonicalRoot, Date.now()) as { id: string } | undefined
    return Boolean(row)
  }

  expireStale(now: number): void {
    this.db
      .prepare(
        `UPDATE execution_runs SET status = 'interrupted', updated_at = ?
         WHERE status = 'active' AND lease_expires_at <= ?`
      )
      .run(now, now)
    this.db
      .prepare(
        `UPDATE execution_pool_slots SET status = 'free', run_id = NULL, lease_owner = NULL,
         lease_expires_at = NULL, released_at = ?
         WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
      )
      .run(now, now)
    this.db
      .prepare(
        `UPDATE workspace_leases SET status = 'expired', released_at = ?
         WHERE status = 'active' AND lease_expires_at <= ?`
      )
      .run(now, now)
  }

  heartbeat(runId: string, leaseOwner: string, now: number): void {
    const expires = now + LEASE_TTL_MS
    const refresh = this.db.transaction(() => {
      const run = this.db
        .prepare(
          `UPDATE execution_runs SET lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND lease_owner = ? AND status = 'active'`
        )
        .run(expires, now, runId, leaseOwner)
      if (run.changes !== 1) throw new Error(`Execution run lease lost: ${runId}`)

      const slot = this.db
        .prepare(
          `UPDATE execution_pool_slots SET lease_expires_at = ?
           WHERE pool = ? AND slot_number = ? AND run_id = ? AND status = 'claimed'`
        )
        .run(expires, EXECUTION_POOL, EXECUTION_SLOT, runId)
      const workspace = this.db
        .prepare(
          `UPDATE workspace_leases SET lease_expires_at = ?
           WHERE run_id = ? AND status = 'active'`
        )
        .run(expires, runId)
      if (slot.changes !== 1 || workspace.changes !== 1) {
        throw new Error(`Execution lease set is incomplete: ${runId}`)
      }
    })
    refresh()
  }
}
