import { findNextPendingJob, getUserJob } from './repository'
import { emitJobEvent } from './service'
import {
  ensureStartupWorkloadReady,
  findActiveSlotOccupantInPool,
  findDbRunningJobGlobal,
  findInMemoryExecutionOccupantGlobal
} from './workload-slot'
import { authorizeUncertainTaskAttemptReplayForJob } from './task-attempts'

/**
 * Clear the uncertain-replay fence for jobs interrupted by process death so auto-resume can
 * create the next attempt (same authorization user Continue applies).
 */
export function prepareInterruptedJobForAutoResume(jobId: string): number {
  return authorizeUncertainTaskAttemptReplayForJob(jobId)
}

export async function startPendingExecutionJob(username: string, jobId: string): Promise<void> {
  const { isEntityDeletionBlocked } = await import('./deletion-coordinator')
  if (isEntityDeletionBlocked('thread_job', jobId)) return

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

  const { acquireWorkspaceLease, releaseWorkspaceLease } = await import('./workspace-lease-store')
  const workspaceLease = acquireWorkspaceLease({
    workspacePath: job.workspacePath ?? '',
    ownerKind: 'thread_job',
    ownerId: jobId
  })
  if (!workspaceLease) return

  // F2 (§7.2): single atomic claim — CAS pending→running + create run/slot +
  // activeRunId + lease in one transaction. On failure the job stays pending.
  const { claimExecutionSlotForJobTx } = await import('./workload-slot-store')
  const slot = await claimExecutionSlotForJobTx(username, jobId)
  if (!slot) {
    const jobAfterClaim = await getUserJob(username, jobId)
    if (jobAfterClaim?.status !== 'running') {
      releaseWorkspaceLease({ leaseId: workspaceLease.leaseId })
    }
    return
  }

  const updated = await getUserJob(username, jobId)
  if (updated) {
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
  }
  const { scheduleJobExecution } = await import('./executor')
  scheduleJobExecution(username, jobId, slot)
}

async function resumeInterruptedRunningJob(username: string, jobId: string): Promise<boolean> {
  const { isEntityDeletionBlocked } = await import('./deletion-coordinator')
  if (isEntityDeletionBlocked('thread_job', jobId)) return false

  const { isJobExecuting } = await import('./controls')
  if (isJobExecuting(jobId)) return true

  const job = await getUserJob(username, jobId)
  if (!job || job.status !== 'running') return false

  const { acquireExecutionLease, clearExecutionLease } = await import('./repository')
  if (!acquireExecutionLease(username, jobId)) return false

  const { acquireWorkspaceLease } = await import('./workspace-lease-store')
  const workspaceLease = acquireWorkspaceLease({
    workspacePath: job.workspacePath ?? '',
    ownerKind: 'thread_job',
    ownerId: jobId
  })
  if (!workspaceLease) {
    clearExecutionLease(jobId)
    return false
  }

  // Process death left Provider-started attempts as interrupted with a stable idempotency key.
  // User Continue/Resume already authorizes replay; auto-resume after restart must do the same or
  // the loop immediately fails with "Automatic replay blocked".
  prepareInterruptedJobForAutoResume(jobId)

  const { resumeJobExecution } = await import('./controls')
  resumeJobExecution(jobId)

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
 * Priority: live loop → resume DB running (restart) → reclaim restart-interrupted paused →
 * promote pending FIFO.
 * Occupancy and FIFO are process-global (capacity 1).
 */
export async function advanceExecutionQueue(_username?: string): Promise<void> {
  await ensureStartupWorkloadReady()

  // FIX-PLAN F3-C (§8.4): while draining for shutdown, reject new claims.
  const { isDraining } = await import('./shutdown-state')
  if (isDraining()) return

  if (findInMemoryExecutionOccupantGlobal()) return

  const running = await findDbRunningJobGlobal()
  if (running) {
    const resumed = await resumeInterruptedRunningJob(running.username, running.id)
    if (resumed) return
  }

  // Belt-and-suspenders: if startup reconcile missed a legacy restart-paused job, reclaim it here
  // before promoting pending FIFO work.
  const { findRestartInterruptedPausedJobId } = await import('./repository')
  const { reconcileStaleJobIfNeeded } = await import('./reconcile')
  const usernames = _username
    ? [_username]
    : await listUsernamesWithRestartInterruptedPausedJobs()
  for (const username of usernames) {
    const pausedId = await findRestartInterruptedPausedJobId(username)
    if (!pausedId) continue
    const job = await getUserJob(username, pausedId)
    if (!job) continue
    console.info('[jobs] reclaiming restart-interrupted paused job', {
      jobId: pausedId,
      username
    })
    await reconcileStaleJobIfNeeded(username, job, { deferQueueAdvance: true })
    const resumed = await resumeInterruptedRunningJob(username, pausedId)
    if (resumed) return
  }

  const liveSlot = await findActiveSlotOccupantInPool('execution')
  if (liveSlot) return

  const next = await findNextPendingJob()
  if (!next) return

  await startPendingExecutionJob(next.username, next.id)
}

async function listUsernamesWithRestartInterruptedPausedJobs(): Promise<string[]> {
  const { getDb } = await import('../db')
  const { threadJobs } = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const rows = await getDb()
    .selectDistinct({ username: threadJobs.username })
    .from(threadJobs)
    .where(eq(threadJobs.status, 'paused'))
  return rows.map((row) => row.username)
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
