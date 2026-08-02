import type { JobCommandBody, JobCommandResult } from '@codetask/contracts'
import type Database from 'better-sqlite3'
import type { Actor } from '../../shared.ts'
import {
  ExecutionForbiddenError,
  ExecutionValidationError,
  nowMs,
  stableHash
} from '../../shared.ts'
import { JobRepository } from '../infrastructure/job-repository.ts'
import { ExecutionOutbox } from '../../events/execution-outbox.ts'

export class DeleteJobService {
  constructor(
    private readonly db: Database.Database,
    private readonly jobs: JobRepository,
    private readonly outbox: ExecutionOutbox
  ) {}

  delete(actor: Actor, jobId: string, body: JobCommandBody): JobCommandResult {
    const requestHash = stableHash(JSON.stringify({ jobId, command: 'delete', body }))
    const existing = this.jobs.getCommandReceipt(actor.userId, body.idempotencyKey)
    if (existing) {
      return JSON.parse(existing.responseJson) as JobCommandResult
    }

    const job = this.jobs.requireById(jobId)
    if (job.actorId !== actor.userId) throw new ExecutionForbiddenError()
    if (job.state === 'running' || job.state === 'pausing' || job.state === 'cancelling') {
      throw new ExecutionValidationError('Cannot delete active job')
    }

    const result: JobCommandResult = {
      jobId,
      state: job.state,
      stateRevision: job.stateRevision,
      accepted: true
    }

    const tx = this.db.transaction(() => {
      this.outbox.enqueue(jobId, 'job.deleted', { jobId }, this.db)
      this.jobs.deleteJob(jobId)
    })
    tx()

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
  }
}
