import {
  createTaskAttempt,
  startAttempt,
  type TaskAttempt
} from '../../domain/tasks/index'
import { JobCommandService } from '../../domain/jobs/transitions'
import type { ApplicationDependencies } from '../dependencies'
import type { ExecuteTaskOutcome } from '../ports/provider-registry'
import type { ProjectedTask } from '../ports/task-projection'
import {
  commitAttemptCheckpoint,
  hashTaskResult,
  type CheckpointOutcome
} from './attempt-checkpoint'
import { assertSingleWriter } from '../policies/workspace-single-writer'

const jobCommands = new JobCommandService()

export type ExecuteTaskWorkInput = {
  readonly jobId: string
  readonly workspaceId: string
  readonly taskId: string
  readonly providerCode?: string
  readonly timeoutMs?: number
  readonly abortSignal?: AbortSignal
  /** Test hooks for fault injection. */
  readonly faults?: {
    readonly beforeProvider?: () => void
    readonly afterProviderBeforeCheckpoint?: () => void | Promise<void>
    readonly beforeCommit?: () => void
  }
}

export type ExecuteTaskWorkResult = {
  readonly attempt: TaskAttempt
  readonly projected: ProjectedTask
  readonly outcome: ExecuteTaskOutcome
  readonly checkpoint: CheckpointOutcome
}

/**
 * Open a task attempt, call Provider port, then checkpoint.
 * Application imports ports only — Fake Provider is wired at composition.
 */
export async function executeTaskWork(
  deps: ApplicationDependencies,
  input: ExecuteTaskWorkInput
): Promise<ExecuteTaskWorkResult> {
  const job = await deps.jobs.get(input.jobId)
  if (!job) throw new Error(`job.not_found: ${input.jobId}`)
  if (job.status === 'cancelled') throw new Error('job.cancelled')
  if (job.status === 'paused' || job.status === 'pausing') {
    throw new Error('job.paused')
  }

  const lease = await deps.leases.get(input.workspaceId)
  assertSingleWriter(input.workspaceId, input.jobId, lease?.holderId ?? null)
  const acquired = await deps.leases.tryAcquire({
    workspaceId: input.workspaceId,
    holderId: input.jobId,
    acquiredAtMs: deps.clock.now().getTime()
  })
  if (!acquired) throw new Error('workspace.single_writer: acquire failed')

  let liveJob = job
  if (liveJob.status === 'queued') {
    liveJob = await deps.unitOfWork.run(async (tx) => {
      const started = jobCommands.start(liveJob)
      await deps.jobs.save(started, { expectedRevision: liveJob.stateRevision })
      tx.enqueueEvent({ type: 'job.started', aggregateId: started.id })
      return started
    })
  }

  const projected = await deps.tasks.get(
    input.jobId,
    liveJob.executionGeneration,
    input.taskId
  )
  if (!projected) throw new Error(`task.not_found: ${input.taskId}`)
  if (projected.status === 'completed') {
    throw new Error(`task.already_completed: ${input.taskId}`)
  }

  const attemptId = deps.ids.next()
  let attempt = createTaskAttempt({
    id: attemptId,
    taskId: input.taskId,
    executionGeneration: liveJob.executionGeneration,
    status: 'pending',
    idempotencyKey: `${input.jobId}:${input.taskId}:${liveJob.executionGeneration}`
  })
  attempt = startAttempt(attempt)

  await deps.unitOfWork.run(async (tx) => {
    await deps.attempts.save(attempt, { jobId: input.jobId })
    await deps.tasks.save({ ...projected, status: 'running' })
    tx.enqueueEvent({ type: 'attempt.opened', aggregateId: attempt.id })
  })

  const providerCode = input.providerCode ?? 'fake'
  const provider = deps.providers.get(providerCode)
  if (!provider) throw new Error(`provider.not_found: ${providerCode}`)

  input.faults?.beforeProvider?.()

  let outcome: ExecuteTaskOutcome
  try {
    if (input.abortSignal?.aborted) {
      outcome = { kind: 'cancelled' }
    } else if (input.timeoutMs != null && input.timeoutMs <= 0) {
      outcome = { kind: 'timeout' }
    } else {
      const executePromise = provider.executeTask({
        jobId: input.jobId,
        taskId: input.taskId,
        attemptId: attempt.id,
        title: projected.task.title,
        abortSignal: input.abortSignal,
        timeoutMs: input.timeoutMs
      })

      if (input.timeoutMs != null) {
        outcome = await raceTimeout(executePromise, input.timeoutMs, input.abortSignal)
      } else {
        outcome = await executePromise
      }
    }
  } catch (error: unknown) {
    if (input.abortSignal?.aborted) {
      outcome = { kind: 'cancelled' }
    } else if (isTimeoutError(error)) {
      outcome = { kind: 'timeout' }
    } else {
      outcome = {
        kind: 'failed',
        errorCode: error instanceof Error ? error.message : 'provider.error'
      }
    }
  }

  // Normalize missing hash
  if (outcome.kind === 'succeeded' && !outcome.resultHash) {
    outcome = {
      kind: 'succeeded',
      resultHash: hashTaskResult(outcome.raw),
      raw: outcome.raw
    }
  }

  await input.faults?.afterProviderBeforeCheckpoint?.()

  const runningProjected: ProjectedTask = { ...projected, status: 'running' }
  const checkpoint = await commitAttemptCheckpoint(deps, {
    jobId: input.jobId,
    job: liveJob,
    projected: runningProjected,
    attempt,
    outcome,
    readJob: () => deps.jobs.get(input.jobId),
    beforeCommit: input.faults?.beforeCommit
  })

  const finalAttempt =
    checkpoint.kind === 'aborted_by_control'
      ? attempt
      : checkpoint.attempt
  const finalProjected =
    checkpoint.kind === 'succeeded' ||
    checkpoint.kind === 'failed' ||
    checkpoint.kind === 'inconclusive'
      ? checkpoint.task
      : runningProjected

  return {
    attempt: finalAttempt,
    projected: finalProjected,
    outcome,
    checkpoint
  }
}

async function raceTimeout(
  promise: Promise<ExecuteTaskOutcome>,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<ExecuteTaskOutcome> {
  return new Promise<ExecuteTaskOutcome>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      resolve({ kind: 'cancelled' })
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    promise
      .then((value) => {
        clearTimeout(timer)
        abortSignal?.removeEventListener('abort', onAbort)
        resolve(value)
      })
      .catch((error: unknown) => {
        clearTimeout(timer)
        abortSignal?.removeEventListener('abort', onAbort)
        reject(error)
      })
  })
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || /timeout/i.test(error.message))
  )
}
