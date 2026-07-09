import { and, eq, or } from 'drizzle-orm'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { threadJobs, type ThreadJob } from '../db/schema'
import type { PlanProgressDto, TaskProgressDto, ThreadJobDto } from './types'
import { defaultPlanProgress } from '../planner/save-plan'
import {
  clearExecutionLease,
  mapJob,
  refreshExecutionLease,
  updateJobRow,
  updateJobRowForSnapshot
} from './repository'
import { emitJobProgressAfterPersist } from './progress-emit'
import { prepareInterruptedExecutionResume, resolveStaleExecutionJobAction } from './execution-recovery'
import { createTurnError } from '../../shared/turn-errors.ts'
import {
  clearActiveRunIfMatches,
  listActiveWorkloadSlots,
  releaseWorkloadSlot,
  type WorkloadRunSummary
} from './workload-slot-store'
import { getRunRuntimeRef } from './workload-slot-store'
import { hardKill, registerRunRuntime, unregisterRunRuntime } from './runtime-supervisor'
import { buildCursorPlannerRuntimeHandle } from './runtime-handle-cursor'

function isJobLoopActive(jobId: string): boolean {
  return getAppContext().executionRuntime.isLoopActive(jobId)
}

function isSessionPlanning(sessionId: string): boolean {
  return getAppContext().runtimeRegistry.isJobPlanning(sessionId)
}

function leaseOwner(): string {
  return `${process.pid}-${getAppContext().bootId}`
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export async function reconcileStaleJobIfNeeded(
  username: string,
  job: ThreadJobDto
): Promise<ThreadJobDto> {
  const action = resolveStaleExecutionJobAction(job)
  if (action === 'noop') return job

  if (isJobLoopActive(job.id)) {
    refreshExecutionLease(job.id)
    return job
  }

  const { progress } = prepareInterruptedExecutionResume(job.taskProgress)

  if (action === 'finalize-user-pause') {
    const taskProgress: TaskProgressDto = {
      ...progress,
      phase: 'running',
      status: 'running',
      message: null,
      progressCode: 'execution.resuming',
      progressParams: null
    }
    const pausedError = createTurnError('job.paused').toDto()
    const updated = await updateJobRowForSnapshot(job.id, {
      status: 'paused',
      taskProgress,
      lastError: pausedError
    })
    if (!updated) return job
    await clearExecutionLease(job.id)
    emitJobProgressAfterPersist(job.id, 'snapshot', { taskProgress, job: updated })
    return updated
  }

  const taskProgress: TaskProgressDto = {
    ...progress,
    phase: 'running',
    status: 'running',
    message: null,
    progressCode: 'execution.interrupted_resume',
    progressParams: null
  }

  const { acquireExecutionLease, clearStaleExecutionLeaseIfNeeded } = await import('./repository')
  clearStaleExecutionLeaseIfNeeded(job.id)
  if (!acquireExecutionLease(username, job.id)) {
    console.warn('[reconcile] could not acquire execution lease after interrupted resume', job.id)
  }

  const updated = await updateJobRowForSnapshot(job.id, {
    status: 'running',
    taskProgress,
    lastError: null
  })
  if (!updated) return job

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
    .where(
      and(
        eq(threadJobs.username, username),
        or(eq(threadJobs.status, 'running'), eq(threadJobs.status, 'pausing'))
      )
    )

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
  const rows = await db
    .select()
    .from(threadJobs)
    .where(
      or(eq(threadJobs.status, 'running'), eq(threadJobs.status, 'pausing'))
    )

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

async function reconcileStalePlanningSessionIfNeeded(session: ThreadJob): Promise<void> {
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

  await updateJobRow(session.id, {
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
    .from(threadJobs)
    .where(and(eq(threadJobs.username, username), eq(threadJobs.status, 'planning')))

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
  const rows = await db.select().from(threadJobs).where(eq(threadJobs.status, 'planning'))

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

export async function reconcileUserPlanningState(username: string): Promise<void> {
  await reconcileOrphanPlanningSessionsForUser(username)
}

export async function reconcileUserExecutionState(username: string): Promise<void> {
  await reconcileOrphanRunningJobsForUser(username)
}

export async function reconcileUserWorkloadState(username: string): Promise<void> {
  await reconcileOrphanWorkloadSlotsForUser(username)
  await reconcileUserExecutionState(username)
  await reconcileUserPlanningState(username)
}

export function resetJobReconcileForTests(): void {
  startupReconciled = false
  startupPlanningReconciled = false
  void import('./job-queue').then((module) => module.resetJobQueueStartupForTests()).catch(() => {})
  void import('./workload-slot')
    .then((module) => module.resetStartupWorkloadGateForTests())
    .catch(() => {})
}

async function killRuntimeForStaleSlot(slot: WorkloadRunSummary): Promise<void> {
  const runtimeRef = await getRunRuntimeRef<{
    kind?: 'cursor-acp' | 'sandbox-worker' | 'job-cursor-pool'
    scopeId?: string
    jobId?: string
  }>(slot.runId)

  if (runtimeRef?.scopeId) {
    registerRunRuntime(slot.runId, buildCursorPlannerRuntimeHandle(runtimeRef.scopeId))
  } else if (runtimeRef?.jobId) {
    registerRunRuntime(slot.runId, buildCursorPlannerRuntimeHandle(runtimeRef.jobId))
  } else if (slot.kind === 'planning') {
    registerRunRuntime(slot.runId, buildCursorPlannerRuntimeHandle(slot.ownerId))
  }

  await hardKill(slot.runId).catch((error) => {
    console.warn('[reconcile] hardKill stale slot failed', slot.runId, error)
  })
  unregisterRunRuntime(slot.runId)
}

export async function reconcileOrphanWorkloadSlotsForUser(username: string): Promise<void> {
  const slots = await listActiveWorkloadSlots({ username })
  const currentOwner = leaseOwner()
  const now = nowSec()

  for (const slot of slots) {
    try {
      const currentPid = slot.leaseOwner === currentOwner
      const leaseValid = slot.leaseExpiresAt ? slot.leaseExpiresAt > now : false

      if (currentPid && leaseValid) {
        if (slot.kind === 'planning') {
          getAppContext().runtimeRegistry.tryStartJobPlanning(slot.ownerId, username)
        }
        continue
      }

      console.warn('[reconcile] releasing stale workload slot', slot.runId, {
        ownerKind: slot.ownerKind,
        ownerId: slot.ownerId,
        currentPid,
        leaseValid
      })

      await killRuntimeForStaleSlot(slot)
      await releaseWorkloadSlot(slot.runId, {
        reason: 'reconcile_stale',
        status: 'released',
        skipQueueAdvance: true
      })
      if (slot.ownerKind === 'thread_job') {
        const { clearStaleExecutionLeaseIfNeeded } = await import('./repository')
        clearStaleExecutionLeaseIfNeeded(slot.ownerId)
      }
      await clearActiveRunIfMatches(slot.ownerKind, slot.ownerId, slot.runId)
    } catch (error) {
      console.warn('[reconcile] failed to reconcile workload slot', slot.runId, error)
    }
  }
}

export async function reconcileOrphanWorkloadSlotsOnStartup(): Promise<void> {
  const slots = await listActiveWorkloadSlots({})
  const currentOwner = leaseOwner()
  const now = nowSec()

  for (const slot of slots) {
    try {
      const currentPid = slot.leaseOwner === currentOwner
      const leaseValid = slot.leaseExpiresAt ? slot.leaseExpiresAt > now : false

      if (currentPid && leaseValid) {
        if (slot.kind === 'planning') {
          getAppContext().runtimeRegistry.tryStartJobPlanning(slot.ownerId, slot.username)
        }
        continue
      }

      console.warn('[reconcile] releasing stale workload slot', slot.runId, {
        ownerKind: slot.ownerKind,
        ownerId: slot.ownerId,
        currentPid,
        leaseValid
      })

      await killRuntimeForStaleSlot(slot)
      await releaseWorkloadSlot(slot.runId, {
        reason: 'startup_reconcile_stale',
        status: 'released',
        skipQueueAdvance: true
      })
      if (slot.ownerKind === 'thread_job') {
        const { clearStaleExecutionLeaseIfNeeded } = await import('./repository')
        clearStaleExecutionLeaseIfNeeded(slot.ownerId)
      }
      await clearActiveRunIfMatches(slot.ownerKind, slot.ownerId, slot.runId)
    } catch (error) {
      console.warn('[reconcile] failed to reconcile workload slot', slot.runId, error)
    }
  }
}

let startupWorkloadSlotsReconciled = false

export async function reconcileOrphanWorkloadSlotsOnStartupOnce(): Promise<void> {
  if (startupWorkloadSlotsReconciled) return
  startupWorkloadSlotsReconciled = true
  await reconcileOrphanWorkloadSlotsOnStartup()
}

let reconcilerTimer: ReturnType<typeof setInterval> | null = null

export function startWorkloadReconciler(): void {
  if (reconcilerTimer) return
  const intervalMs = 5 * 60_000

  reconcilerTimer = setInterval(() => {
    void reconcileOrphanWorkloadSlotsOnStartup().catch((error) => {
      console.warn('[reconcile] periodic workload slot reconciler failed', error)
    })
    void reconcileOrphanRunningJobsOnStartup().catch((error) => {
      console.warn('[reconcile] periodic running jobs reconciler failed', error)
    })
    void reconcileOrphanPlanningSessionsOnStartup().catch((error) => {
      console.warn('[reconcile] periodic planning sessions reconciler failed', error)
    })
  }, intervalMs)
  reconcilerTimer.unref?.()
}

export function stopWorkloadReconcilerForTests(): void {
  if (reconcilerTimer) {
    clearInterval(reconcilerTimer)
    reconcilerTimer = null
  }
}
