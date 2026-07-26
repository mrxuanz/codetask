import { illegalJobTransition } from './errors'
import type { Job, JobStatus } from './types'

const TERMINAL: ReadonlySet<JobStatus> = new Set(['completed', 'cancelled'])

function bump(job: Job, status: JobStatus, patch?: Partial<Pick<Job, 'executionGeneration'>>): Job {
  return {
    ...job,
    status,
    stateRevision: job.stateRevision + 1,
    ...(patch ?? {})
  }
}

/**
 * Single entry for Job status transitions. Pure — no I/O.
 * Pause / Continue / Cancel / Retry are idempotent where already satisfied.
 */
export class JobCommandService {
  /**
   * Pause request:
   * - running → pausing
   * - queued → paused (no active run)
   * - pausing / paused → no-op (idempotent; repeat pause on paused ok)
   */
  pause(job: Job): Job {
    switch (job.status) {
      case 'paused':
      case 'pausing':
        return job
      case 'queued':
        return bump(job, 'paused')
      case 'running':
        return bump(job, 'pausing')
      default:
        throw illegalJobTransition(job.status, 'pause')
    }
  }

  /** paused → queued; already queued is idempotent. Does not bump executionGeneration. */
  continue(job: Job): Job {
    switch (job.status) {
      case 'queued':
        return job
      case 'paused':
        return bump(job, 'queued')
      default:
        throw illegalJobTransition(job.status, 'continue')
    }
  }

  /** Non-terminal → cancelled; already cancelled is idempotent. */
  cancel(job: Job): Job {
    if (job.status === 'cancelled') return job
    if (job.status === 'completed') throw illegalJobTransition(job.status, 'cancel')
    return bump(job, 'cancelled')
  }

  /**
   * failed|verification → queued (repair/retry). Already queued is idempotent.
   * Opens a new executionGeneration; continue never does.
   */
  retry(job: Job): Job {
    switch (job.status) {
      case 'queued':
        return job
      case 'failed':
      case 'verification':
        return bump(job, 'queued', {
          executionGeneration: job.executionGeneration + 1
        })
      default:
        throw illegalJobTransition(job.status, 'retry')
    }
  }

  /** queued → running. */
  start(job: Job): Job {
    if (job.status !== 'queued') throw illegalJobTransition(job.status, 'start')
    return bump(job, 'running')
  }

  /** running|pausing|verification → failed. */
  markFailed(job: Job): Job {
    switch (job.status) {
      case 'running':
      case 'pausing':
      case 'verification':
        return bump(job, 'failed')
      default:
        throw illegalJobTransition(job.status, 'markFailed')
    }
  }

  /** running → verification. */
  enterVerification(job: Job): Job {
    if (job.status !== 'running') throw illegalJobTransition(job.status, 'enterVerification')
    return bump(job, 'verification')
  }

  /** verification → completed. Task success alone must not call this. */
  complete(job: Job): Job {
    if (job.status !== 'verification') throw illegalJobTransition(job.status, 'complete')
    return bump(job, 'completed')
  }

  isTerminal(job: Job): boolean {
    return TERMINAL.has(job.status)
  }
}
