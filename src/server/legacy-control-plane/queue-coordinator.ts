import { findNextPendingJob, getUserJob, updateJobRowForSnapshot } from './repository'
import { emitJobEvent } from './service'
import {
  ensureStartupWorkloadReady,
  findActiveSlotOccupantInPool,
  findDbRunningJobGlobal,
  findInMemoryExecutionOccupantGlobal
} from './workload-slot'
import {
  authorizeUncertainTaskAttemptReplayForJob,
  jobHasUncertainReplayFence
} from './task-attempts'
import { createTurnError } from '../../shared/turn-errors.ts'

/**
 * Explicit user Continue authorizes uncertain replay.
 * Startup auto-resume must NOT call this — that would silently change at-most-once semantics.
 */
export function prepareInterruptedJobForUserContinue(jobId: string): number {
  return authorizeUncertainTaskAttemptReplayForJob(jobId)
}

/** @deprecated Use prepareInterruptedJobForUserContinue; kept for test migration. */
export function prepareInterruptedJobForAutoResume(jobId: string): number {
  return prepareInterruptedJobForUserContinue(jobId)
}

export async function startPendingExecutionJob(username: string, jobId: string): Promise<void> {
  const { isEntityDeletionBlocked } = await import('./deletion-coordinator')
  if (isEntityDeletionBlocked('thread_job', jobId)) return

  const job = await getUserJob(username, jobId)
  if (!job || job.status !== 'pending') return
  if (!job.plan?.tasks?.length) {
    const { updateJobRow } = await import('./repository')
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

/**
 * Uncertain Provider outcomes must not auto-resume. Hold as paused with structured recovery
 * so the user can authorize_replay / continue explicitly.
 */
async function settleUncertainProviderOutcome(username: string, jobId: string): Promise<void> {
  const job = await getUserJob(username, jobId)
  if (!job) return
  const updated = await updateJobRowForSnapshot(jobId, {
    status: 'paused',
    suspensionKind: 'policy_hold',
    recoveryReason: 'uncertain_provider_outcome',
    continueAfterPause: false,
    lastError: createTurnError('job.paused', {
      detail: 'Provider outcome is uncertain after restart; authorize replay to continue'
    }).toDto()
  })
  if (updated) {
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
  }
  const { clearExecutionLease } = await import('./repository')
  await clearExecutionLease(jobId)
}

async function resumeInterruptedRunningJob(username: string, jobId: string): Promise<boolean> {
  const { isEntityDeletionBlocked } = await import('./deletion-coordinator')
  if (isEntityDeletionBlocked('thread_job', jobId)) return false

  const { isJobExecuting } = await import('./controls')
  if (isJobExecuting(jobId)) return true

  const job = await getUserJob(username, jobId)
  if (!job || job.status !== 'running') return false

  // Do not silently authorize uncertain fences on startup.
  if (jobHasUncertainReplayFence(jobId)) {
    await settleUncertainProviderOutcome(username, jobId)
    return false
  }

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
 * Priority: live loop → resume DB running (restart) → promote pending FIFO.
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

  const liveSlot = await findActiveSlotOccupantInPool('execution')
  if (liveSlot) return

  const next = await findNextPendingJob()
  if (!next) return

  await startPendingExecutionJob(next.username, next.id)
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
