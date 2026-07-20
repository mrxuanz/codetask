import { and, eq, or } from 'drizzle-orm'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { threadJobs, type ThreadJob } from '../db/schema'
import type { PlanProgressDto, TaskProgressDto, ThreadJobDto } from './types'
import { defaultPlanProgress } from '../planner/save-plan'
import {
  clearExecutionLease,
  getUserJob,
  mapJob,
  refreshExecutionLease,
  updateJobRow,
  updateJobRowForSnapshot
} from './repository'
import { emitJobProgressAfterPersist } from './progress-emit'
import {
  prepareInterruptedExecutionResume,
  resolveStaleExecutionJobAction
} from './execution-recovery'
import { createTurnError } from '../../shared/turn-errors.ts'
import {
  clearActiveRunIfMatches,
  listActiveWorkloadSlots,
  releaseWorkloadSlot,
  type WorkloadRunSummary
} from './workload-slot-store'
import { getRunRuntimeRef } from './workload-slot-store'
import { registerRunRuntime } from './runtime-supervisor'
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

interface ReconcileStaleJobOptions {
  readonly deferQueueAdvance?: boolean
}

export async function reconcileStaleJobIfNeeded(
  username: string,
  job: ThreadJobDto,
  options: ReconcileStaleJobOptions = {}
): Promise<ThreadJobDto> {
  const action = resolveStaleExecutionJobAction(job)
  if (action === 'noop') return job

  if (isJobLoopActive(job.id)) {
    refreshExecutionLease(job.id)
    return job
  }

  const { progress } = prepareInterruptedExecutionResume(job.taskProgress)

  if (action === 'finalize-user-pause') {
    const continueAfter = job.continueAfterPause === true
    const taskProgress: TaskProgressDto = {
      ...progress,
      phase: 'running',
      status: 'pending',
      message: null,
      progressCode: continueAfter ? 'execution.resuming' : 'execution.pending',
      progressParams: null
    }
    const pausedError = createTurnError('job.paused').toDto()
    const updated = await updateJobRowForSnapshot(job.id, {
      status: 'paused',
      taskProgress,
      lastError: pausedError,
      suspensionKind: job.suspensionKind ?? 'user_pause',
      continueAfterPause: continueAfter,
      recoveryReason: null
    })
    if (!updated) return job
    await clearExecutionLease(job.id)
    emitJobProgressAfterPersist(job.id, 'snapshot', { taskProgress, job: updated })

    if (continueAfter) {
      const { settleContinueAfterPause } = await import('./controls')
      await settleContinueAfterPause(username, job.id).catch((error) => {
        console.warn(
          '[jobs] continue_after_pause failed after reconcile pause settle',
          job.id,
          error
        )
      })
      const latest = await getUserJob(username, job.id)
      return latest ?? updated
    }
    return updated
  }

  // FIX-PLAN F3-A (§8.1): process interruption (app shutdown / crash) must AUTO-RESUME the
  // running Job. It is NOT a user failure. Keep the Job in a recoverable `running` state, reset
  // interrupted in-flight tasks to queued, drop the stale lease so a fresh boot can re-lease, then
  // trigger the single execution-queue entry to resume it. Any DB-completed task is never re-run
  // (its job_tasks row stays `completed`, so the gate will not re-select it).
  const taskProgress: TaskProgressDto = {
    ...progress,
    phase: 'running',
    status: 'running',
    message: null,
    progressCode: 'execution.resuming',
    progressParams: null
  }

  const updated = await updateJobRowForSnapshot(job.id, {
    status: 'running',
    taskProgress,
    lastError: null
  })
  if (!updated) return job

  // Drop the dead process's lease so advanceExecutionQueue can re-acquire it this boot.
  await clearExecutionLease(job.id)

  // Mark any DB attempt still `running`/`starting` from the dead process as interrupted so the
  // resumed loop creates the next attempt under the same (job_id, task_id) identity.
  const { markRunningAttemptsInterruptedForJob } = await import('./task-attempts')
  markRunningAttemptsInterruptedForJob(job.id)

  emitJobProgressAfterPersist(job.id, 'snapshot', { taskProgress, job: updated })

  if (!options.deferQueueAdvance) {
    // Runtime reconcile can advance immediately because the startup gate is already open.
    const { advanceExecutionQueue } = await import('./queue-coordinator')
    await advanceExecutionQueue(username)
  }

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
        or(
          eq(threadJobs.status, 'running'),
          eq(threadJobs.status, 'pausing'),
          eq(threadJobs.status, 'paused')
        )
      )
    )

  const errors: Error[] = []
  for (const row of rows) {
    try {
      const job = await mapJob(row, { includePlan: true })
      await reconcileStaleJobIfNeeded(username, job)
    } catch (error) {
      console.warn('[jobs] failed to reconcile orphan running job', row.id, error)
      errors.push(new Error(`running job ${row.id}`, { cause: error }))
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to reconcile running jobs')
}

export async function reconcileOrphanRunningJobsOnStartup(
  options: ReconcileStaleJobOptions = {}
): Promise<void> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(
      or(
        eq(threadJobs.status, 'running'),
        eq(threadJobs.status, 'pausing'),
        eq(threadJobs.status, 'paused')
      )
    )

  const errors: Error[] = []
  for (const row of rows) {
    try {
      const job = await mapJob(row, { includePlan: true })
      await reconcileStaleJobIfNeeded(row.username, job, options)
    } catch (error) {
      console.warn('[jobs] failed to reconcile orphan running job', row.id, error)
      errors.push(new Error(`running job ${row.id}`, { cause: error }))
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to reconcile running jobs')
}

let startupReconciled = false
let startupReconcilePromise: Promise<void> | null = null

export async function reconcileOrphanRunningJobsOnStartupOnce(
  options: ReconcileStaleJobOptions = {}
): Promise<void> {
  if (startupReconciled) return
  if (startupReconcilePromise) return startupReconcilePromise

  startupReconcilePromise = reconcileOrphanRunningJobsOnStartup(options)
    .then(() => {
      startupReconciled = true
    })
    .finally(() => {
      startupReconcilePromise = null
    })

  return startupReconcilePromise
}

async function reconcileStalePlanningSessionIfNeeded(session: ThreadJob): Promise<void> {
  if (session.status !== 'planning') return
  if (isSessionPlanning(session.id)) return
  // Queued for a planning slot — not an orphan; advancePlanningQueue starts these.
  if (session.planStatus === 'pending') return
  // Just created / about to claim: planStatus=running but no activeRunId yet.
  // Only treat as orphan after a short grace so advancePlanningQueue cannot race create.
  if (session.planStatus === 'running' && !session.activeRunId) {
    const ageSec = nowSec() - (session.updatedAt ?? 0)
    if (ageSec < 120) return
  }

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

  const errors: Error[] = []
  for (const row of rows) {
    try {
      await reconcileStalePlanningSessionIfNeeded(row)
    } catch (error) {
      console.warn('[jobs] failed to reconcile orphan planning session', row.id, error)
      errors.push(new Error(`planning job ${row.id}`, { cause: error }))
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to reconcile planning jobs')
}

export async function reconcileOrphanPlanningSessionsOnStartup(): Promise<void> {
  const db = getDb()
  const rows = await db.select().from(threadJobs).where(eq(threadJobs.status, 'planning'))

  const errors: Error[] = []
  for (const row of rows) {
    try {
      await reconcileStalePlanningSessionIfNeeded(row)
    } catch (error) {
      console.warn('[jobs] failed to reconcile orphan planning session', row.id, error)
      errors.push(new Error(`planning job ${row.id}`, { cause: error }))
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to reconcile planning jobs')
}

let startupPlanningReconciled = false
let startupPlanningReconcilePromise: Promise<void> | null = null

export async function reconcileOrphanPlanningSessionsOnStartupOnce(): Promise<void> {
  if (startupPlanningReconciled) return
  if (startupPlanningReconcilePromise) return startupPlanningReconcilePromise

  startupPlanningReconcilePromise = reconcileOrphanPlanningSessionsOnStartup()
    .then(() => {
      startupPlanningReconciled = true
    })
    .finally(() => {
      startupPlanningReconcilePromise = null
    })

  return startupPlanningReconcilePromise
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
  startupWorkloadSlotsReconciled = false
  startupReconcilePromise = null
  startupPlanningReconcilePromise = null
  startupWorkloadSlotsReconcilePromise = null
  void import('./job-queue').then((module) => module.resetJobQueueStartupForTests()).catch(() => {})
  void import('./workload-slot')
    .then((module) => module.resetStartupWorkloadGateForTests())
    .catch(() => {})
  void import('../conversation/service')
    .then((module) => module.resetConversationReconcileForTests())
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

  const { stopRunLifecycle } = await import('./run-lifecycle')
  await stopRunLifecycle(slot.runId, 'reconcile_stale', {}, { skipRelease: true })
}

const PLANNING_TERMINAL_SLOT_GRACE_SEC = 60

async function planningSlotOwnerFinished(slot: WorkloadRunSummary, now: number): Promise<boolean> {
  if (slot.kind !== 'planning' || slot.ownerKind !== 'thread_job') return false
  const row = await getDb()
    .select({
      activeRunId: threadJobs.activeRunId,
      status: threadJobs.status,
      planStatus: threadJobs.planStatus,
      updatedAt: threadJobs.updatedAt
    })
    .from(threadJobs)
    .where(eq(threadJobs.id, slot.ownerId))
    .limit(1)
    .then((rows) => rows[0] ?? null)
  if (!row || row.activeRunId !== slot.runId) return true

  const planFinished = row.planStatus === 'completed' || row.planStatus === 'failed'
  const ownerLeftPlanning = row.status !== 'planning'
  if (!planFinished && !ownerLeftPlanning) return false
  return now - row.updatedAt >= PLANNING_TERMINAL_SLOT_GRACE_SEC
}

async function reconcileWorkloadSlots(
  slots: WorkloadRunSummary[],
  reason: 'reconcile_stale' | 'startup_reconcile_stale' | 'periodic_reconcile_stale'
): Promise<void> {
  const currentOwner = leaseOwner()
  const now = nowSec()

  const errors: Error[] = []
  for (const slot of slots) {
    try {
      const currentPid = slot.leaseOwner === currentOwner
      const leaseValid = slot.leaseExpiresAt ? slot.leaseExpiresAt > now : false
      const ownerFinished = await planningSlotOwnerFinished(slot, now)

      if (currentPid && leaseValid && !ownerFinished) {
        if (slot.kind === 'planning') {
          getAppContext().runtimeRegistry.tryStartJobPlanning(slot.ownerId, slot.username)
        }
        continue
      }

      console.warn('[reconcile] releasing stale workload slot', slot.runId, {
        ownerKind: slot.ownerKind,
        ownerId: slot.ownerId,
        currentPid,
        leaseValid,
        ownerFinished
      })

      await killRuntimeForStaleSlot(slot)
      await releaseWorkloadSlot(slot.runId, {
        reason,
        status: 'released',
        skipQueueAdvance: true
      })
      if (slot.kind === 'planning') {
        getAppContext().runtimeRegistry.endJobPlanning(slot.ownerId)
      }
      if (slot.kind === 'execution' && slot.ownerKind === 'thread_job') {
        const { clearStaleExecutionLeaseIfNeeded } = await import('./repository')
        clearStaleExecutionLeaseIfNeeded(slot.ownerId)
      }
      await clearActiveRunIfMatches(slot.ownerKind, slot.ownerId, slot.runId)
    } catch (error) {
      console.warn('[reconcile] failed to reconcile workload slot', slot.runId, error)
      errors.push(new Error(`workload slot ${slot.runId}`, { cause: error }))
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to reconcile workload slots')
}

export async function reconcileOrphanWorkloadSlotsForUser(username: string): Promise<void> {
  const slots = await listActiveWorkloadSlots({ username })
  await reconcileWorkloadSlots(slots, 'reconcile_stale')
}

export async function reconcileOrphanWorkloadSlotsOnStartup(
  reason: 'startup_reconcile_stale' | 'periodic_reconcile_stale' = 'startup_reconcile_stale'
): Promise<void> {
  const slots = await listActiveWorkloadSlots({})
  await reconcileWorkloadSlots(slots, reason)
}

let startupWorkloadSlotsReconciled = false
let startupWorkloadSlotsReconcilePromise: Promise<void> | null = null

export async function reconcileOrphanWorkloadSlotsOnStartupOnce(): Promise<void> {
  if (startupWorkloadSlotsReconciled) return
  if (startupWorkloadSlotsReconcilePromise) return startupWorkloadSlotsReconcilePromise

  startupWorkloadSlotsReconcilePromise = reconcileOrphanWorkloadSlotsOnStartup()
    .then(() => {
      startupWorkloadSlotsReconciled = true
    })
    .finally(() => {
      startupWorkloadSlotsReconcilePromise = null
    })

  return startupWorkloadSlotsReconcilePromise
}

let reconcilerTimer: ReturnType<typeof setInterval> | null = null
let periodicReconcilePromise: Promise<void> | null = null

export const WORKLOAD_RECONCILE_INTERVAL_MS = 60_000

export async function runPeriodicWorkloadReconcile(): Promise<void> {
  if (periodicReconcilePromise) return periodicReconcilePromise
  periodicReconcilePromise = (async () => {
    const results = await Promise.allSettled([
      reconcileOrphanWorkloadSlotsOnStartup('periodic_reconcile_stale'),
      reconcileOrphanRunningJobsOnStartup(),
      reconcileOrphanPlanningSessionsOnStartup()
    ])
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('[reconcile] periodic workload reconcile step failed', result.reason)
      }
    }

    // Queue advancement is deliberately outside the startup reconcile gate.
    // Running it every cycle also repairs a previously missed release event.
    const { advanceAllQueues } = await import('./queue-coordinator')
    await advanceAllQueues()
  })().finally(() => {
    periodicReconcilePromise = null
  })
  return periodicReconcilePromise
}

export function startWorkloadReconciler(): void {
  if (reconcilerTimer) return

  reconcilerTimer = setInterval(() => {
    void runPeriodicWorkloadReconcile().catch((error) => {
      console.warn('[reconcile] periodic workload reconciler failed', error)
    })
  }, WORKLOAD_RECONCILE_INTERVAL_MS)
  reconcilerTimer.unref?.()
}

export function stopWorkloadReconciler(): void {
  if (reconcilerTimer) {
    clearInterval(reconcilerTimer)
    reconcilerTimer = null
  }
  periodicReconcilePromise = null
}

/** @deprecated Use stopWorkloadReconciler */
export function stopWorkloadReconcilerForTests(): void {
  stopWorkloadReconciler()
}
