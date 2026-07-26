import type { ApplicationDependencies } from '../dependencies'
import {
  pauseJobCommand,
  type PauseJobCommand
} from '../commands/pause-job'
import {
  continueJobCommand,
  type ContinueJobCommand
} from '../commands/continue-job'
import {
  cancelJobCommand,
  type CancelJobCommand
} from '../commands/cancel-job'
import {
  retryJobCommand,
  type RetryJobCommand
} from '../commands/retry-job'
import type { CommandResult } from '../results'
import type { Job } from '../../domain/jobs/types'

export type JobControlWorkResult = CommandResult<{ job: Job }>

/** Idempotent pause work — wraps pauseJobCommand. */
export async function pauseJobWork(
  deps: ApplicationDependencies,
  command: PauseJobCommand
): Promise<JobControlWorkResult> {
  return pauseJobCommand(deps, command)
}

/** Idempotent continue work — wraps continueJobCommand. */
export async function continueJobWork(
  deps: ApplicationDependencies,
  command: ContinueJobCommand
): Promise<JobControlWorkResult> {
  return continueJobCommand(deps, command)
}

/** Idempotent cancel work — wraps cancelJobCommand. */
export async function cancelJobWork(
  deps: ApplicationDependencies,
  command: CancelJobCommand
): Promise<JobControlWorkResult> {
  const result = await cancelJobCommand(deps, command)
  if (result.ok) {
    // Best-effort: release any workspace leases held by this job.
    const leases = await deps.leases.listAll()
    for (const lease of leases) {
      if (lease.holderId === command.jobId) {
        await deps.leases.release(lease.workspaceId, command.jobId)
      }
    }
  }
  return result
}

/** Idempotent retry work — wraps retryJobCommand (bumps executionGeneration). */
export async function retryJobWork(
  deps: ApplicationDependencies,
  command: RetryJobCommand
): Promise<JobControlWorkResult> {
  return retryJobCommand(deps, command)
}
