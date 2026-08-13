import type { JobCommandBody, JobCommandResult } from '@codetask/contracts'
import type Database from 'better-sqlite3'
import type { Actor } from '../../shared.ts'
import {
  ExecutionConflictError,
  ExecutionForbiddenError,
  ExecutionValidationError,
  nowMs,
  stableHash
} from '../../shared.ts'
import { JobRepository } from '../infrastructure/job-repository.ts'
import { ExecutionOutbox } from '../../events/execution-outbox.ts'
import type { JobAssetPort } from './submit-job.ts'

export class DeleteJobService {
  constructor(
    private readonly db: Database.Database,
    private readonly jobs: JobRepository,
    private readonly outbox: ExecutionOutbox,
    private readonly assets?: JobAssetPort
  ) {}

  delete(actor: Actor, jobId: string, body: JobCommandBody): JobCommandResult {
    let releasedAssets = false
    const requestHash = stableHash(
      JSON.stringify({
        jobId,
        command: 'delete',
        expectedRevision: body.expectedRevision,
        authorizeReplay: body.authorizeReplay ?? false
      })
    )
    const execute = this.db.transaction((): JobCommandResult => {
      const existing = this.jobs.getCommandReceipt(actor.userId, body.idempotencyKey)
      if (existing) {
        if (
          existing.jobId === jobId &&
          existing.command === 'delete' &&
          existing.requestHash === requestHash
        ) {
          return JSON.parse(existing.responseJson) as JobCommandResult
        }
        throw new ExecutionConflictError('Idempotency key reused for a different Job command')
      }

      const job = this.jobs.requireById(jobId)
      if (job.actorId !== actor.userId) throw new ExecutionForbiddenError()
      if (job.stateRevision !== body.expectedRevision) {
        throw new ExecutionConflictError('Job state revision does not match')
      }
      if (job.state === 'running' || job.state === 'pausing' || job.state === 'cancelling') {
        throw new ExecutionValidationError('Cannot delete active job')
      }

      const result: JobCommandResult = {
        jobId,
        state: job.state,
        stateRevision: job.stateRevision,
        accepted: true
      }

      // These execution tables intentionally have no foreign keys. Clear them in the
      // same transaction so a deleted Job cannot continue to affect queue ordering,
      // dependency queries or realtime delivery. Command receipts are retained as
      // idempotency tombstones, including after the Job row is gone.
      this.db.prepare(`DELETE FROM job_slice_dependencies WHERE job_id = ?`).run(jobId)
      this.db.prepare(`DELETE FROM job_work_dependencies WHERE job_id = ?`).run(jobId)
      this.db.prepare(`DELETE FROM job_work_references WHERE job_id = ?`).run(jobId)
      this.db.prepare(`DELETE FROM repair_generations WHERE job_id = ?`).run(jobId)
      this.db.prepare(`DELETE FROM execution_queue_entries WHERE job_id = ?`).run(jobId)
      this.db.prepare(`DELETE FROM execution_outbox WHERE job_id = ?`).run(jobId)
      this.db
        .prepare(
          `UPDATE execution_pool_slots SET status = 'free', run_id = NULL,
           lease_owner = NULL, lease_expires_at = NULL
           WHERE run_id IN (SELECT id FROM execution_runs WHERE job_id = ?)`
        )
        .run(jobId)
      this.db
        .prepare(`DELETE FROM workspace_leases WHERE owner_type = 'job-run' AND owner_id = ?`)
        .run(jobId)
      this.assets?.releaseJob(jobId)
      releasedAssets = Boolean(this.assets)
      this.db
        .prepare(
          `UPDATE job_handoffs
              SET status = 'failed', job_id = NULL, payload_json = '{}',
                  last_error_json = ?, failed_at = ?, next_attempt_at = NULL
            WHERE job_id = ?`
        )
        .run(JSON.stringify({ message: 'Published Job was deleted' }), nowMs(), jobId)
      this.db
        .prepare(
          `UPDATE planning_sessions
              SET status = 'failed', published_job_id = NULL, published_at = NULL,
                  last_error_json = ?, updated_at = ?
            WHERE published_job_id = ?`
        )
        .run(JSON.stringify({ message: 'Published Job was deleted' }), nowMs(), jobId)
      this.jobs.deleteJob(jobId)
      this.outbox.enqueue(
        jobId,
        'job.deleted',
        { jobId, actorId: actor.userId, state: job.state, revision: job.stateRevision },
        this.db
      )
      this.jobs.saveCommandReceipt({
        actorId: actor.userId,
        idempotencyKey: body.idempotencyKey,
        jobId,
        command: 'delete',
        requestHash,
        responseJson: JSON.stringify(result),
        createdAt: nowMs()
      })
      return result
    })
    const result = execute()
    if (releasedAssets) this.assets?.onReferencesReleased?.()
    return result
  }
}
