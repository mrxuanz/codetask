import { JobCommandService } from '../../domain/jobs/transitions'
import type { Job } from '../../domain/jobs/types'
import { markInconclusive, type TaskAttempt } from '../../domain/tasks/index'
import type { ApplicationDependencies } from '../dependencies'

const jobCommands = new JobCommandService()

export type ReconcileProcessPresence = {
  readonly jobId: string
  /** True when an OS/runtime process for this job is known alive. */
  readonly processAlive: boolean
}

export type StartupReconcileInput = {
  /** Jobs that appear non-terminal in durable state. */
  readonly jobs: readonly Job[]
  readonly processPresence: readonly ReconcileProcessPresence[]
  /** Max lease age before considered stale (ms). */
  readonly leaseMaxAgeMs?: number
}

export type StartupReconcileResult = {
  readonly clearedLeases: number
  readonly interruptedAttempts: number
  readonly jobsUpdated: readonly Job[]
  /** Explicit: never derived success from missing process. */
  readonly markedSuccessFromMissingProcess: false
}

/**
 * Startup reconcile:
 * - Clear stale workspace leases
 * - Interrupt non-terminal attempts when process is missing
 * - NEVER mark attempt/job success solely because the process is gone
 */
export async function startupReconcile(
  deps: ApplicationDependencies,
  input: StartupReconcileInput
): Promise<StartupReconcileResult> {
  const nowMs = deps.clock.now().getTime()
  const leaseMaxAgeMs = input.leaseMaxAgeMs ?? 0
  let clearedLeases =
    leaseMaxAgeMs > 0 ? await deps.leases.clearStale(nowMs, leaseMaxAgeMs) : 0

  const alive = new Map(input.processPresence.map((p) => [p.jobId, p.processAlive]))
  for (const lease of await deps.leases.listAll()) {
    const isAlive = alive.get(lease.holderId)
    if (isAlive === false) {
      await deps.leases.release(lease.workspaceId, lease.holderId)
      clearedLeases += 1
    }
  }

  const nonTerminal = await deps.attempts.listNonTerminal()
  let interruptedAttempts = 0
  const jobsUpdated: Job[] = []

  await deps.unitOfWork.run(async (tx) => {
    for (const row of nonTerminal) {
      const processAlive = alive.get(row.jobId)
      if (processAlive !== false) continue

      // Missing process ⇒ interrupt / inconclusive — NEVER succeed.
      let next: TaskAttempt
      if (row.status === 'running') {
        next = markInconclusive(row, 'reconcile.process_missing')
      } else if (row.status === 'pending') {
        next = {
          ...row,
          status: 'failed',
          errorCode: 'reconcile.process_missing',
          resultHash: null
        }
      } else {
        continue
      }

      await deps.attempts.save(next, { jobId: row.jobId })
      interruptedAttempts += 1
      tx.enqueueEvent({
        type: 'attempt.reconciled_interrupted',
        aggregateId: next.id,
        payload: { reason: 'process_missing' }
      })
    }

    for (const job of input.jobs) {
      const processAlive = alive.get(job.id)
      if (processAlive !== false) continue

      if (job.status === 'running' || job.status === 'pausing' || job.status === 'verification') {
        let next: Job
        if (job.status === 'pausing') {
          next = { ...job, status: 'paused', stateRevision: job.stateRevision + 1 }
        } else {
          next = jobCommands.markFailed(job)
        }
        await deps.jobs.save(next, { expectedRevision: job.stateRevision })
        jobsUpdated.push(next)
        tx.enqueueEvent({
          type: 'job.reconciled_interrupted',
          aggregateId: next.id,
          payload: { reason: 'process_missing' }
        })
      }
    }
  })

  return {
    clearedLeases,
    interruptedAttempts,
    jobsUpdated,
    markedSuccessFromMissingProcess: false
  }
}
