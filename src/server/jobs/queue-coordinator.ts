import { findNextPendingJobId, getUserJob } from './repository'
import { emitJobEvent } from './service'
import {
  ensureStartupWorkloadReady,
  findActiveSlotOccupantInPool,
  findDbRunningJobId,
  findInMemoryExecutionOccupant
} from './workload-slot'

async function startPendingJob(username: string, jobId: string): Promise<void> {
  const job = await getUserJob(username, jobId)
  if (!job || job.status !== 'pending') return
  if (!job.plan?.tasks?.length) {
    const { updateJobRow } = await import('./repository')
    const { createTurnError } = await import('../../shared/turn-errors.ts')
    await updateJobRow(jobId, {
      status: 'failed',
      lastError: createTurnError('turn.unknown', {
        detail: 'Execution tree is empty; cannot start job'
      }).toDto()
    })
    return
  }

  const { tryPromoteJobToRunning } = await import('./repository')
  const started = await tryPromoteJobToRunning(username, jobId)
  if (!started) return

  const updated = await getUserJob(username, jobId)
  if (updated) {
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
  }
  const { scheduleJobExecution } = await import('./executor')
  scheduleJobExecution(username, jobId)
}

async function resumeInterruptedRunningJob(username: string, jobId: string): Promise<boolean> {
  const { isJobExecuting } = await import('./controls')
  if (isJobExecuting(jobId)) return true

  const job = await getUserJob(username, jobId)
  if (!job || job.status !== 'running') return false

  const { acquireExecutionLease } = await import('./repository')
  if (!acquireExecutionLease(username, jobId)) return false

  const updated = await getUserJob(username, jobId)
  if (updated) {
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
  }

  const { scheduleJobExecution } = await import('./executor')
  scheduleJobExecution(username, jobId)
  return true
}

/**
 * Single execution-queue advance exit.
 * Startup reconcile runs before this via ensureStartupWorkloadReady.
 * Priority: live loop → resume DB running (restart) → promote pending FIFO.
 */
export async function advanceExecutionQueue(username: string): Promise<void> {
  await ensureStartupWorkloadReady()

  if (findInMemoryExecutionOccupant(username)) return

  const runningId = await findDbRunningJobId(username)
  if (runningId) {
    await resumeInterruptedRunningJob(username, runningId)
    return
  }

  const liveSlot = await findActiveSlotOccupantInPool(username, 'execution')
  if (liveSlot) return

  const nextId = await findNextPendingJobId(username)
  if (!nextId) return

  await startPendingJob(username, nextId)
}

export async function advancePlanningQueue(username: string): Promise<void> {
  await ensureStartupWorkloadReady()
  const { reconcileUserPlanningState } = await import('./reconcile')
  await reconcileUserPlanningState(username)

  const { findPlanningOccupant } = await import('./workload-slot')
  if (await findPlanningOccupant(username)) return

  const { tryStartPendingDesignSessionPlanning } = await import('../design-session/planner')
  await tryStartPendingDesignSessionPlanning(username)
}

export async function advanceAllQueues(username: string): Promise<void> {
  await advanceExecutionQueue(username)
  await advancePlanningQueue(username)
}
