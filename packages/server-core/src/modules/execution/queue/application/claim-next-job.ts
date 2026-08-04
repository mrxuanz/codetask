import type Database from 'better-sqlite3'
import { EXECUTION_POOL, EXECUTION_SLOT, LEASE_TTL_MS, newId, nowMs } from '../../shared.ts'
import { ExecutionOutbox } from '../../events/execution-outbox.ts'

export type ClaimNextResult = { runId: string; jobId: string } | null

export function createClaimNextJobService(deps: {
  db: Database.Database
  outbox: ExecutionOutbox
  leaseOwner: string
}): { claimNext(): ClaimNextResult } {
  return {
    claimNext(): ClaimNextResult {
      const now = nowMs()
      const expires = now + LEASE_TTL_MS

      const tx = deps.db.transaction(() => {
        const entry = deps.db
          .prepare(
            `SELECT q.job_id, q.generation FROM execution_queue_entries q
             JOIN jobs j ON j.id = q.job_id
             WHERE q.status = 'queued' AND j.state = 'queued'
             ORDER BY q.priority DESC, q.enqueued_at ASC, q.sequence ASC, q.job_id ASC
             LIMIT 1`
          )
          .get() as { job_id: string; generation: number } | undefined
        if (!entry) return null

        const job = deps.db
          .prepare(`SELECT * FROM jobs WHERE id = ? AND state = 'queued'`)
          .get(entry.job_id) as Record<string, unknown> | undefined
        if (!job) return null

        const slot = deps.db
          .prepare(`SELECT status FROM execution_pool_slots WHERE pool = ? AND slot_number = ?`)
          .get(EXECUTION_POOL, EXECUTION_SLOT) as { status: string } | undefined
        if (!slot || slot.status !== 'free') return null

        const canonicalRoot = job.canonical_workspace_root as string
        const activeLease = deps.db
          .prepare(
            `SELECT id FROM workspace_leases
             WHERE canonical_workspace_root = ? AND status = 'active' AND lease_expires_at > ?`
          )
          .get(canonicalRoot, now)
        if (activeLease) return null

        const runId = newId('run')
        const leaseId = newId('wlease')

        deps.db
          .prepare(
            `INSERT INTO execution_runs (
              id, job_id, generation, status, lease_owner, lease_expires_at,
              fencing_token, started_at, updated_at
            ) VALUES (?, ?, ?, 'active', ?, ?, 1, ?, ?)`
          )
          .run(runId, entry.job_id, entry.generation, deps.leaseOwner, expires, now, now)

        deps.db
          .prepare(
            `UPDATE execution_pool_slots SET
              run_id = ?, status = 'claimed', lease_owner = ?, lease_expires_at = ?, claimed_at = ?
             WHERE pool = ? AND slot_number = ? AND status = 'free'`
          )
          .run(runId, deps.leaseOwner, expires, now, EXECUTION_POOL, EXECUTION_SLOT)

        deps.db
          .prepare(
            `INSERT INTO workspace_leases (
              id, canonical_workspace_root, owner_type, owner_id, run_id,
              status, lease_owner, lease_expires_at, created_at
            ) VALUES (?, ?, 'job-run', ?, ?, 'active', ?, ?, ?)`
          )
          .run(leaseId, canonicalRoot, entry.job_id, runId, deps.leaseOwner, expires, now)

        deps.db
          .prepare(
            `UPDATE execution_queue_entries SET status = 'claimed', claimed_at = ?
             WHERE job_id = ? AND generation = ? AND status = 'queued'`
          )
          .run(now, entry.job_id, entry.generation)

        deps.db
          .prepare(
            `UPDATE jobs SET state = 'running', current_run_id = ?, started_at = ?, updated_at = ?,
             state_revision = state_revision + 1
             WHERE id = ? AND state = 'queued'`
          )
          .run(runId, now, now, entry.job_id)

        deps.outbox.enqueue(entry.job_id, 'job.started', { jobId: entry.job_id, runId }, deps.db)

        return { runId, jobId: entry.job_id }
      })

      return tx()
    }
  }
}
