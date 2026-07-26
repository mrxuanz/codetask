import { JobCommandService } from '../../domain/jobs/transitions'
import type { Job } from '../../domain/jobs/types'
import type { JobRepo } from '../ports/repositories'
import type { UnitOfWork } from '../ports/unit-of-work'
import type { IdempotencyStore } from '../idempotency'
import { fail, type CommandResult } from '../results'
import { mapThrownToResult, withIdempotency, type CommandBase } from './helpers'

const jobCommands = new JobCommandService()

export type CancelJobCommand = CommandBase & {
  readonly jobId: string
  readonly expectedRevision: number
}

export type CancelJobDeps = {
  readonly jobs: JobRepo
  readonly unitOfWork: UnitOfWork
  readonly idempotency: IdempotencyStore
}

export async function cancelJobCommand(
  deps: CancelJobDeps,
  command: CancelJobCommand
): Promise<CommandResult<{ job: Job }>> {
  return withIdempotency(deps.idempotency, command, async () => {
    try {
      return await deps.unitOfWork.run(async (tx) => {
        const job = await deps.jobs.get(command.jobId)
        if (!job) {
          return fail('job.not_found', `Job not found: ${command.jobId}`)
        }
        const next = jobCommands.cancel(job)
        if (next !== job) {
          await deps.jobs.save(next, { expectedRevision: command.expectedRevision })
          tx.enqueueEvent({ type: 'job.cancelled', aggregateId: next.id })
        }
        return { ok: true as const, value: { job: next } }
      })
    } catch (error: unknown) {
      return mapThrownToResult(error)
    }
  })
}
