import {
  asVerificationAttemptId,
  assertNotForgingCompleted,
  completeVerification,
  decideJobCompletion,
  startVerification,
  type VerificationAttempt,
  type VerificationResult,
  type VerificationScope
} from '../../domain/verification/index'
import { JobCommandService } from '../../domain/jobs/transitions'
import type { Job } from '../../domain/jobs/types'
import type { ApplicationDependencies } from '../dependencies'
import type { ProjectedTask } from '../ports/task-projection'

const jobCommands = new JobCommandService()

export type VerifyWorkInput = {
  readonly kind: VerificationScope
  readonly jobId: string
  readonly scopeId: string
  /** Evaluator returns structured verdict — never forge inconclusive→pass. */
  readonly evaluate: (input: {
    readonly job: Job
    readonly tasks: readonly ProjectedTask[]
    readonly scopeId: string
    readonly kind: VerificationScope
  }) => Promise<VerificationResult> | VerificationResult
}

export type VerifyWorkResult = {
  readonly attempt: VerificationAttempt
  readonly job: Job
  readonly decision: ReturnType<typeof decideJobCompletion>
}

/**
 * Slice / milestone / job verification work.
 * Job may complete only after required verification passes.
 */
export async function verifyWork(
  deps: ApplicationDependencies,
  input: VerifyWorkInput
): Promise<VerifyWorkResult> {
  const job = await deps.jobs.get(input.jobId)
  if (!job) throw new Error(`job.not_found: ${input.jobId}`)

  const tasks = await deps.tasks.listForJob(input.jobId, job.executionGeneration)

  let liveJob = job
  if (liveJob.status === 'running') {
    liveJob = await deps.unitOfWork.run(async (tx) => {
      const next = jobCommands.enterVerification(liveJob)
      await deps.jobs.save(next, { expectedRevision: liveJob.stateRevision })
      tx.enqueueEvent({ type: 'job.verification_entered', aggregateId: next.id })
      return next
    })
  }

  const attemptId = asVerificationAttemptId(deps.ids.next())
  let attempt: VerificationAttempt = {
    id: attemptId,
    jobId: input.jobId,
    scope: input.kind,
    scopeId: input.scopeId,
    status: 'pending',
    executionGeneration: liveJob.executionGeneration,
    result: null
  }

  const started = startVerification(attempt)
  if (!started.ok) throw new Error(started.error.code)
  attempt = { ...attempt, status: started.value.nextStatus }
  await deps.verifications.save(attempt)

  const result = await input.evaluate({
    job: liveJob,
    tasks,
    scopeId: input.scopeId,
    kind: input.kind
  })

  // Hard guard: inconclusive must never be treated as pass.
  if (result.verdict === 'inconclusive') {
    const forged = assertNotForgingCompleted('inconclusive')
    if (forged.ok) {
      throw new Error('verification.invariant_broken: inconclusive forged to pass')
    }
  }

  const completed = completeVerification(attempt, result)
  if (!completed.ok) throw new Error(completed.error.code)
  attempt = {
    ...attempt,
    status: completed.value.nextStatus,
    result: completed.value.result
  }

  const decision = decideJobCompletion(result.verdict)

  const nextJob = await deps.unitOfWork.run(async (tx) => {
    await deps.verifications.save(attempt)
    tx.enqueueEvent({
      type: 'verification.completed',
      aggregateId: attempt.id,
      payload: { verdict: result.verdict, scope: input.kind, scopeId: input.scopeId }
    })

    let updated = liveJob
    const expectedRevision = liveJob.stateRevision
    if (decision.kind === 'complete') {
      // Only pass may complete the job.
      const forgeGuard = assertNotForgingCompleted(result.verdict)
      if (!forgeGuard.ok) throw new Error(forgeGuard.error.code)
      if (updated.status !== 'verification') {
        updated = jobCommands.enterVerification(updated)
      }
      updated = jobCommands.complete(updated)
      await deps.jobs.save(updated, { expectedRevision })
      tx.enqueueEvent({ type: 'job.completed', aggregateId: updated.id })
    } else if (decision.kind === 'fail') {
      if (updated.status !== 'verification') {
        updated = jobCommands.enterVerification(updated)
      }
      updated = jobCommands.markFailed(updated)
      await deps.jobs.save(updated, { expectedRevision })
      tx.enqueueEvent({ type: 'job.failed', aggregateId: updated.id })
    } else {
      // block_inconclusive — leave job in verification; never completed
      tx.enqueueEvent({
        type: 'verification.inconclusive_blocked',
        aggregateId: attempt.id
      })
    }
    return updated
  })

  return { attempt, job: nextJob, decision }
}

/** Convenience wrappers. */
export function verifySliceWork(
  deps: ApplicationDependencies,
  input: Omit<VerifyWorkInput, 'kind'>
): Promise<VerifyWorkResult> {
  return verifyWork(deps, { ...input, kind: 'slice' })
}

export function verifyMilestoneWork(
  deps: ApplicationDependencies,
  input: Omit<VerifyWorkInput, 'kind'>
): Promise<VerifyWorkResult> {
  return verifyWork(deps, { ...input, kind: 'milestone' })
}
