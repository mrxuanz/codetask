import { and, eq } from 'drizzle-orm'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { designSessions, threadJobs } from '../db/schema'
import type { PlanProgressDto, TaskProgressDto, ThreadJobDto } from './types'
import { defaultPlanProgress } from '../planner/save-plan'
import {
  clearExecutionLease,
  mapJob,
  refreshExecutionLease,
  updateJobRowForSnapshot
} from './repository'
import { emitJobProgressAfterPersist } from './progress-emit'
import { prepareInterruptedExecutionResume } from './execution-recovery'
import { createTurnError } from '../../shared/turn-errors.ts'

function isJobLoopActive(jobId: string): boolean {
  return getAppContext().executionRuntime.isLoopActive(jobId)
}

function isSessionPlanning(sessionId: string): boolean {
  return getAppContext().runtimeRegistry.isJobPlanning(sessionId)
}

export async function reconcileStaleJobIfNeeded(
  _username: string,
  job: ThreadJobDto
): Promise<ThreadJobDto> {
  if (job.status !== 'running') return job
  if (isJobLoopActive(job.id)) {
    refreshExecutionLease(job.id)
    return job
  }

  const { progress } = prepareInterruptedExecutionResume(job.taskProgress)
  const taskProgress: TaskProgressDto = {
    ...progress,
    message: null,
    progressCode: 'execution.stale_running',
    progressParams: null
  }

  const updated = await updateJobRowForSnapshot(job.id, {
    status: 'pending',
    taskProgress,
    lastError: null
  })
  if (!updated) return job

  await clearExecutionLease(job.id)
  emitJobProgressAfterPersist(job.id, 'snapshot', { taskProgress, job: updated })
  return updated
}

export async function reconcileJobsForUser(
  username: string,
  jobs: ThreadJobDto[]
): Promise<ThreadJobDto[]> {
  const reconciled: ThreadJobDto[] = []
  for (const job of jobs) {
    reconciled.push(await reconcileStaleJobIfNeeded(username, job))
  }
  return reconciled
}

export async function reconcileOrphanRunningJobsForUser(username: string): Promise<void> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(and(eq(threadJobs.username, username), eq(threadJobs.status, 'running')))

  for (const row of rows) {
    try {
      const job = await mapJob(row, { includePlan: true })
      await reconcileStaleJobIfNeeded(username, job)
    } catch (error) {
      console.warn('[jobs] failed to reconcile orphan running job', row.id, error)
    }
  }
}

export async function reconcileOrphanRunningJobsOnStartup(): Promise<void> {
  const db = getDb()
  const rows = await db.select().from(threadJobs).where(eq(threadJobs.status, 'running'))

  for (const row of rows) {
    try {
      const job = await mapJob(row, { includePlan: true })
      await reconcileStaleJobIfNeeded(row.username, job)
    } catch (error) {
      console.warn('[jobs] failed to reconcile orphan running job', row.id, error)
    }
  }
}

let startupReconciled = false

export async function reconcileOrphanRunningJobsOnStartupOnce(): Promise<void> {
  if (startupReconciled) return
  startupReconciled = true
  await reconcileOrphanRunningJobsOnStartup()
}

async function reconcileStalePlanningSessionIfNeeded(
  session: typeof designSessions.$inferSelect
): Promise<void> {
  if (session.status !== 'planning') return
  if (isSessionPlanning(session.id)) return

  const planProgress: PlanProgressDto = {
    ...defaultPlanProgress(),
    phase: 'idle',
    status: 'failed',
    message: null,
    progressCode: 'plan.planning_failed',
    progressParams: null
  }

  const { updateDesignSessionRow } = await import('../design-session/service')
  await updateDesignSessionRow(session.id, {
    status: 'failed',
    phase: 'plan_edit',
    planProgress,
    lastError: createTurnError('turn.unknown', {
      detail: 'Planning interrupted before completion'
    }).toDto()
  })
  getAppContext().runtimeRegistry.endJobPlanning(session.id)
}

export async function reconcileOrphanPlanningSessionsForUser(username: string): Promise<void> {
  const db = getDb()
  const rows = await db
    .select()
    .from(designSessions)
    .where(and(eq(designSessions.username, username), eq(designSessions.status, 'planning')))

  for (const row of rows) {
    try {
      await reconcileStalePlanningSessionIfNeeded(row)
    } catch (error) {
      console.warn('[jobs] failed to reconcile orphan planning session', row.id, error)
    }
  }
}

export async function reconcileOrphanPlanningSessionsOnStartup(): Promise<void> {
  const db = getDb()
  const rows = await db.select().from(designSessions).where(eq(designSessions.status, 'planning'))

  for (const row of rows) {
    try {
      await reconcileStalePlanningSessionIfNeeded(row)
    } catch (error) {
      console.warn('[jobs] failed to reconcile orphan planning session', row.id, error)
    }
  }
}

let startupPlanningReconciled = false

export async function reconcileOrphanPlanningSessionsOnStartupOnce(): Promise<void> {
  if (startupPlanningReconciled) return
  startupPlanningReconciled = true
  await reconcileOrphanPlanningSessionsOnStartup()
}

export function resetJobReconcileForTests(): void {
  startupReconciled = false
  startupPlanningReconciled = false
  void import('./job-queue').then((module) => module.resetJobQueueStartupForTests()).catch(() => {})
  void import('./workload-slot')
    .then((module) => module.resetStartupWorkloadGateForTests())
    .catch(() => {})
}
