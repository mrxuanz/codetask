import { createHash } from 'node:crypto'
import {
  failAttempt,
  markInconclusive,
  succeedAttempt,
  type TaskAttempt
} from '../../domain/tasks/index'
import type { ExecuteTaskOutcome } from '../ports/provider-registry'
import type { ProjectedTask } from '../ports/task-projection'
import type { UnitOfWork } from '../ports/unit-of-work'
import type { AttemptRepo, TaskProjectionRepo } from '../ports/task-projection'
import type { JobRepo } from '../ports/repositories'
import type { Job } from '../../domain/jobs/types'
import { JobCommandService } from '../../domain/jobs/transitions'

const jobCommands = new JobCommandService()

export function hashTaskResult(raw: unknown): string {
  const payload = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
  return createHash('sha256').update(payload).digest('hex')
}

export type CheckpointOutcome =
  | { readonly kind: 'succeeded'; readonly attempt: TaskAttempt; readonly task: ProjectedTask }
  | { readonly kind: 'failed'; readonly attempt: TaskAttempt; readonly task: ProjectedTask }
  | { readonly kind: 'inconclusive'; readonly attempt: TaskAttempt; readonly task: ProjectedTask }
  | { readonly kind: 'cancelled'; readonly attempt: TaskAttempt }
  | { readonly kind: 'aborted_by_control'; readonly reason: 'paused' | 'cancelled' }

export type AttemptCheckpointDeps = {
  readonly unitOfWork: UnitOfWork
  readonly attempts: AttemptRepo
  readonly tasks: TaskProjectionRepo
  readonly jobs: JobRepo
}

export type AttemptCheckpointInput = {
  readonly jobId: string
  readonly job: Job
  readonly projected: ProjectedTask
  readonly attempt: TaskAttempt
  readonly outcome: ExecuteTaskOutcome
  /** Re-read job control before commit; if cancelled/pausing, do not succeed. */
  readonly readJob?: () => Promise<Job | undefined>
  readonly beforeCommit?: () => void
}

/**
 * Atomically persist attempt terminal status + task projection checkpoint.
 * Cancel/pause that wins the race prevents a success checkpoint.
 */
export async function commitAttemptCheckpoint(
  deps: AttemptCheckpointDeps,
  input: AttemptCheckpointInput
): Promise<CheckpointOutcome> {
  return deps.unitOfWork.run(async (tx) => {
    const liveJob = input.readJob ? await input.readJob() : input.job
    if (!liveJob) {
      throw new Error(`job.not_found: ${input.jobId}`)
    }

    if (liveJob.status === 'cancelled') {
      const attempt = failAttempt(input.attempt, 'job.cancelled')
      await deps.attempts.save(attempt, { jobId: input.jobId })
      tx.enqueueEvent({ type: 'attempt.cancelled', aggregateId: attempt.id })
      return { kind: 'aborted_by_control', reason: 'cancelled' as const }
    }

    if (liveJob.status === 'pausing' || liveJob.status === 'paused') {
      // Provider may have finished, but pause wins: do not mark task completed.
      tx.enqueueEvent({
        type: 'attempt.checkpoint_deferred_pause',
        aggregateId: input.attempt.id
      })
      return { kind: 'aborted_by_control', reason: 'paused' as const }
    }

    input.beforeCommit?.()

    if (input.outcome.kind === 'cancelled') {
      const attempt = failAttempt(input.attempt, 'provider.cancelled')
      await deps.attempts.save(attempt, { jobId: input.jobId })
      const task: ProjectedTask = { ...input.projected, status: 'failed' }
      await deps.tasks.save(task)
      tx.enqueueEvent({ type: 'attempt.failed', aggregateId: attempt.id })
      return { kind: 'cancelled', attempt }
    }

    if (input.outcome.kind === 'timeout') {
      const attempt = failAttempt(input.attempt, 'runtime.timeout')
      await deps.attempts.save(attempt, { jobId: input.jobId })
      const task: ProjectedTask = { ...input.projected, status: 'failed' }
      await deps.tasks.save(task)
      const failedJob = jobCommands.markFailed(liveJob)
      await deps.jobs.save(failedJob, { expectedRevision: liveJob.stateRevision })
      tx.enqueueEvent({ type: 'attempt.failed', aggregateId: attempt.id })
      return { kind: 'failed', attempt, task }
    }

    if (input.outcome.kind === 'failed') {
      const attempt = failAttempt(input.attempt, input.outcome.errorCode)
      await deps.attempts.save(attempt, { jobId: input.jobId })
      const task: ProjectedTask = { ...input.projected, status: 'failed' }
      await deps.tasks.save(task)
      const failedJob = jobCommands.markFailed(liveJob)
      await deps.jobs.save(failedJob, { expectedRevision: liveJob.stateRevision })
      tx.enqueueEvent({ type: 'attempt.failed', aggregateId: attempt.id })
      return { kind: 'failed', attempt, task }
    }

    if (input.outcome.kind === 'inconclusive') {
      const attempt = markInconclusive(
        input.attempt,
        input.outcome.errorCode ?? 'provider.inconclusive'
      )
      await deps.attempts.save(attempt, { jobId: input.jobId })
      // Task stays non-completed; inconclusive must never forge success.
      tx.enqueueEvent({ type: 'attempt.inconclusive', aggregateId: attempt.id })
      return { kind: 'inconclusive', attempt, task: input.projected }
    }

    // succeeded
    const resultHash =
      input.outcome.kind === 'succeeded'
        ? input.outcome.resultHash
        : hashTaskResult(null)
    const attempt = succeedAttempt(input.attempt, resultHash)
    await deps.attempts.save(attempt, { jobId: input.jobId })
    const task: ProjectedTask = { ...input.projected, status: 'completed' }
    await deps.tasks.save(task)
    tx.enqueueEvent({
      type: 'attempt.succeeded',
      aggregateId: attempt.id,
      payload: { taskId: task.task.id, resultHash }
    })
    return { kind: 'succeeded', attempt, task }
  })
}
