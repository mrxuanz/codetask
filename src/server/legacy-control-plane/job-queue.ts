import { eq } from 'drizzle-orm'
import { defaultPlanProgress } from '../planner/save-plan'
import { getDb } from '../db'
import { threadJobs } from '../db/schema'
import { emitJobEvent } from './service'
import {
  EXECUTION_OCCUPYING_STATUSES,
  findNextPendingJobId,
  findOccupyingJobId,
  findRestartInterruptedPausedJobId,
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

export async function advanceJobQueue(username: string): Promise<void> {
  const { advanceExecutionQueue } = await import('./queue-coordinator')
  await advanceExecutionQueue(username)
}

export async function resumeJobQueueForUser(username: string): Promise<void> {
  const { advanceAllQueues } = await import('./queue-coordinator')
  await advanceAllQueues(username)
}

export async function resumeJobQueuesAfterServerReady(supervisor?: {
  ensureReady(): Promise<void>
}): Promise<void> {
  try {
    await ensureStartupWorkloadReady()
  } catch (error) {
    console.warn('[jobs] startup workload gate failed; queue resume skipped', error)
    return
  }
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
  const [pendingRows, pausedRows, runningRows] = await Promise.all([
    db
      .selectDistinct({ username: threadJobs.username })
      .from(threadJobs)
      .where(eq(threadJobs.status, 'pending')),
    db
      .selectDistinct({ username: threadJobs.username })
      .from(threadJobs)
      .where(eq(threadJobs.status, 'paused')),
    db
      .selectDistinct({ username: threadJobs.username })
      .from(threadJobs)
      .where(eq(threadJobs.status, 'running'))
  ])

  const usernames = new Set([
    ...pendingRows.map((row) => row.username),
    ...pausedRows.map((row) => row.username),
    ...runningRows.map((row) => row.username)
  ])

  for (const username of usernames) {
    try {
      await resumeJobQueueForUser(username)
    } catch (error) {
      console.warn('[jobs] startup queue resume failed', username, error)
    }
  }

  if (usernames.size > 0) {
    console.info('[jobs] startup queue resume finished', { users: [...usernames] })
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
