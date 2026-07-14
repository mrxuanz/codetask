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
  // FIX-PLAN F3-C (§8.5): fail closed — do not swallow readiness errors. The caller runs this
  // BEFORE HTTP listen, so a rejection prevents claiming the runtime is ready.
  await ensureStartupWorkloadReady()
  if (supervisor) {
    await supervisor.ensureReady()
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

  // FIX-PLAN F3-C (§8.5): aggregate per-user failures into a startup failure instead of printing
  // and permanently skipping the user.
  const failures: Array<{ username: string; error: unknown }> = []
  for (const username of usernames) {
    try {
      await resumeJobQueueForUser(username)
    } catch (error) {
      console.warn('[jobs] startup queue resume failed', username, error)
      failures.push({ username, error })
    }
  }

  if (failures.length > 0) {
    const detail = failures
      .map(({ username, error }) => `${username}: ${error instanceof Error ? error.message : String(error)}`)
      .join('; ')
    throw new Error(`Startup queue resume failed for ${failures.length} user(s): ${detail}`)
  }

  if (usernames.size > 0) {
    console.info('[jobs] startup queue resume finished', { users: [...usernames] })
  }
}

let startupQueueResumed = false

/**
 * FIX-PLAN F3-C (§8.5): `startupQueueResumed` flips to true only after a fully successful resume.
 * On failure it stays false so startup can be retried (fail closed, no permanent skip).
 */
export async function resumeJobQueuesOnStartupOnce(): Promise<void> {
  if (startupQueueResumed) return
  try {
    await resumeJobQueuesOnStartup()
    startupQueueResumed = true
  } catch (error) {
    startupQueueResumed = false
    throw error
  }
}

export function isStartupQueueResumed(): boolean {
  return startupQueueResumed
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
