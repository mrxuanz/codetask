import { eq } from 'drizzle-orm'
import { defaultPlanProgress } from '../planner/save-plan'
import { createTurnError } from '../../shared/turn-errors.ts'
import { getDb } from '../db'
import { threadJobs } from '../db/schema'
import { emitJobEvent } from './service'
import {
  EXECUTION_OCCUPYING_STATUSES,
  findNextPendingJobId,
  findOccupyingJobId,
  findRestartInterruptedPausedJobId,
  getUserJob,
  tryPromoteJobToRunning,
  updateJobRow,
  updateJobRowForSnapshot
} from './repository'
import type { PlanProgressDto } from './types'
import { ensureStartupWorkloadReady } from './workload-slot'

export const pendingPlanProgress = (): PlanProgressDto => ({
  ...defaultPlanProgress(),
  phase: 'idle',
  status: 'pending',
  message: null,
  progressCode: 'execution.pending',
  progressParams: null
})

export async function claimJobSlotOrEnqueue(
  username: string,
  jobId: string
): Promise<'claimed' | 'queued'> {
  await ensureStartupWorkloadReady()
  const occupying = await findOccupyingJobId(username, jobId)
  if (!occupying) return 'claimed'

  const updated = await updateJobRowForSnapshot(jobId, {
    status: 'pending',
    planProgress: pendingPlanProgress(),
    lastError: null
  })
  if (updated) {
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
  }
  return 'queued'
}

async function startPendingJob(username: string, jobId: string): Promise<void> {
  const job = await getUserJob(username, jobId)
  if (!job || job.status !== 'pending') return
  if (!job.plan?.tasks?.length) {
    await updateJobRow(jobId, {
      status: 'failed',
      lastError: createTurnError('turn.unknown', {
        detail: 'Execution tree is empty; cannot start job'
      }).toDto()
    })
    return
  }

  const started = await tryPromoteJobToRunning(username, jobId)
  if (!started) return

  const updated = await getUserJob(username, jobId)
  if (updated) {
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
  }
  const { scheduleJobExecution } = await import('./executor')
  scheduleJobExecution(username, jobId)
}

async function tryResumeRestartInterruptedJob(username: string): Promise<boolean> {
  const jobId = await findRestartInterruptedPausedJobId(username)
  if (!jobId) return false
  if (await findOccupyingJobId(username, jobId)) return false
  const { resumePausedJob } = await import('./controls')
  await resumePausedJob(username, jobId)
  return true
}

async function prepareJobQueueForUser(username: string): Promise<void> {
  const { reconcileOrphanRunningJobsForUser, reconcileOrphanPlanningSessionsForUser } =
    await import('./reconcile')
  await reconcileOrphanRunningJobsForUser(username)
  await reconcileOrphanPlanningSessionsForUser(username)
}

export async function advanceJobQueue(username: string): Promise<void> {
  await ensureStartupWorkloadReady()
  await prepareJobQueueForUser(username)
  if (await findOccupyingJobId(username)) return

  if (await tryResumeRestartInterruptedJob(username)) return

  const nextId = await findNextPendingJobId(username)
  if (!nextId) return

  await startPendingJob(username, nextId)
}

/** Reconcile zombie runtimes, then start the next pending job when the execution slot is free. */
export async function resumeJobQueueForUser(username: string): Promise<void> {
  await ensureStartupWorkloadReady()
  await prepareJobQueueForUser(username)
  if (await findOccupyingJobId(username)) return
  await advanceJobQueue(username)
}

export async function resumeJobQueuesAfterServerReady(supervisor?: {
  ensureReady(): Promise<void>
}): Promise<void> {
  await ensureStartupWorkloadReady()
  if (supervisor) {
    try {
      await supervisor.ensureReady()
    } catch (error) {
      console.warn('[jobs] sandbox not ready for queue resume', error)
    }
  }
  await resumeJobQueuesOnStartupOnce()
}

export async function resumeJobQueuesOnStartup(): Promise<void> {
  const db = getDb()
  const [pendingRows, pausedRows] = await Promise.all([
    db
      .selectDistinct({ username: threadJobs.username })
      .from(threadJobs)
      .where(eq(threadJobs.status, 'pending')),
    db
      .selectDistinct({ username: threadJobs.username })
      .from(threadJobs)
      .where(eq(threadJobs.status, 'paused'))
  ])

  const usernames = new Set([
    ...pendingRows.map((row) => row.username),
    ...pausedRows.map((row) => row.username)
  ])

  for (const username of usernames) {
    try {
      await resumeJobQueueForUser(username)
    } catch (error) {
      console.warn('[jobs] startup queue resume failed', username, error)
    }
  }
}

let startupQueueResumed = false

export async function resumeJobQueuesOnStartupOnce(): Promise<void> {
  if (startupQueueResumed) return
  startupQueueResumed = true
  await resumeJobQueuesOnStartup()
}

export function resetJobQueueStartupForTests(): void {
  startupQueueResumed = false
}

export {
  EXECUTION_OCCUPYING_STATUSES,
  findOccupyingJobId,
  findNextPendingJobId,
  findRestartInterruptedPausedJobId
}
