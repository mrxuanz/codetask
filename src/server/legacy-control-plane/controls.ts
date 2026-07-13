import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { isPlanningJobStatus } from '@shared/design-session'
import { deriveJobRecoveryState } from '@shared/job-recovery-state'
import { JOB_CANCELLED, JOB_PAUSED } from '../../shared/turn-errors.ts'
import { AppError } from '../error'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { loadJobPlan } from '../db/job-plan'
import { threadJobs } from '../db/schema'
import type { TaskProgressDto, ThreadJobDto } from './types'
import type { ThreadJobStatus } from '@shared/contracts/jobs'
import type { SavedJobPlan } from '../planner/plan-types'
import { defaultPlanProgress } from '../planner/save-plan'
import { emitJobEvent, getUserJob, updateJobRow, updateJobRowForSnapshot } from './service'
import { claimJobSlotOrEnqueue, findOccupyingJobId } from './job-queue'
import { acquireExecutionLease, clearExecutionLease } from './repository'
import { prepareInterruptedExecutionResume } from './execution-recovery'
import { prepareContinueFailedExecution } from './continue-failed-job'
import { releaseJobCursorResources, cancelJobSandboxTurns } from '../sandbox'
import { purgeJobFilesystem } from '../retention/purge'
import { getControlPlaneServices } from '../application/control-plane-services'
import { isV3Authoritative } from '../application/cutover-state'
import {
  pauseJobViaCommand,
  cancelJobViaCommand,
  continueJobViaCommand,
  restartJobViaCommand
} from '../application/controls-command-adapter'

export type { JobControlState } from '../context/job-execution-runtime'
import { JobExecutionRuntimeRegistry } from '../context/job-execution-runtime'

function executionRuntime(): JobExecutionRuntimeRegistry {
  return getAppContext().executionRuntime
}

export function getJobRuntime(jobId: string): ReturnType<JobExecutionRuntimeRegistry['get']> {
  return executionRuntime().get(jobId)
}

export function isJobExecuting(jobId: string): boolean {
  return executionRuntime().isLoopActive(jobId)
}

export function attachAbortController(jobId: string, controller: AbortController): void {
  executionRuntime().attachAbortController(jobId, controller)
}

export function clearAbortController(jobId: string): void {
  executionRuntime().clearAbortController(jobId)
}

export function abortActiveTurn(jobId: string, reason?: unknown): void {
  executionRuntime().abortActiveTurn(jobId, reason)
}

export function pauseJobExecution(jobId: string): void {
  executionRuntime().setControl(jobId, 'paused')
  abortActiveTurn(jobId, JOB_PAUSED)
  clearAbortController(jobId)
  cancelJobSandboxTurns(jobId)
}

export function resumeJobExecution(jobId: string): void {
  executionRuntime().resumeExecution(jobId)
}

export function shouldStopExecution(jobId: string): 'pause' | 'cancel' | null {
  return executionRuntime().shouldStopExecution(jobId)
}

async function loadPlan(jobId: string): Promise<SavedJobPlan | null> {
  return loadJobPlan(getDb(), jobId)
}

function mapCommandError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'job.not_found') {
    throw AppError.notFound('Job not found', 'job.not_found')
  }
  if (message === 'job.revision_conflict') {
    throw AppError.conflict('Job revision conflict', undefined, 'job.revision_conflict')
  }
  if (message.startsWith('job.')) {
    throw AppError.badRequest(message, message)
  }
  throw error instanceof Error ? error : new Error(message)
}

function mapV3StateToLegacyStatus(state: string): ThreadJobStatus | null {
  switch (state) {
    case 'pausing':
      return 'pausing'
    case 'paused':
      return 'paused'
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return 'failed'
    case 'succeeded':
      return 'completed'
    case 'execution_queued':
    case 'planning_queued':
      return 'pending'
    case 'execution_running':
      return 'running'
    case 'planning_running':
      return 'planning'
    case 'plan_review':
      return 'plan_ready'
    default:
      return null
  }
}

function getAuthoritativeControlJob(jobId: string, username: string) {
  const ctx = getAppContext()
  if (!isV3Authoritative(ctx.db)) return null
  return getControlPlaneServices(ctx).queryService.getJob(jobId, { username })
}

/**
 * Attach V3 availableActions + stateRevision when a control_jobs row exists.
 * Used by legacy routes (C5) so the renderer does not invent actions from status.
 */
export function attachControlPlaneJobFields(username: string, job: ThreadJobDto): ThreadJobDto {
  const v3 = getAuthoritativeControlJob(job.id, username)
  if (!v3) return job
  return {
    ...job,
    stateRevision: v3.stateRevision,
    availableActions: [...v3.availableActions]
  }
}

async function mirrorControlStateToLegacy(
  jobId: string,
  v3State: string,
  extra?: { lastError?: ThreadJobDto['lastError'] }
): Promise<ThreadJobDto | null> {
  const status = mapV3StateToLegacyStatus(v3State)
  if (!status) {
    return null
  }
  return updateJobRowForSnapshot(jobId, {
    status,
    ...(extra?.lastError !== undefined ? { lastError: extra.lastError } : {})
  })
}

async function pauseJobViaControlPlane(
  username: string,
  jobId: string,
  expectedRevision: number
): Promise<ThreadJobDto> {
  let result: { id: string; state: string; stateRevision: number }
  try {
    result = await pauseJobViaCommand(getAppContext(), username, jobId, expectedRevision)
  } catch (error) {
    mapCommandError(error)
  }

  const pausedError = JOB_PAUSED.toDto()
  // Runtime side effects only — Command is the state authority.
  executionRuntime().setControl(jobId, 'paused')
  if (result.state === 'pausing') {
    abortActiveTurn(jobId, JOB_PAUSED)
    cancelJobSandboxTurns(jobId)
  } else {
    abortActiveTurn(jobId, JOB_PAUSED)
    clearAbortController(jobId)
    cancelJobSandboxTurns(jobId)
    const { stopAndReleaseActiveRun } = await import('./workload-slot-store')
    await stopAndReleaseActiveRun('thread_job', jobId, 'paused')
  }

  const mirrored = await mirrorControlStateToLegacy(
    jobId,
    result.state,
    result.state === 'paused' ? { lastError: pausedError } : undefined
  )
  const latest = mirrored ?? (await getUserJob(username, jobId))
  if (!latest) throw AppError.internal('Failed to pause job', 'job.invalid_status')
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job: latest } })
  return attachControlPlaneJobFields(username, latest)
}

async function cancelJobViaControlPlane(
  username: string,
  jobId: string,
  expectedRevision: number
): Promise<ThreadJobDto> {
  let result: { id: string; state: string; stateRevision: number; runIdToStop: string | null }
  try {
    result = await cancelJobViaCommand(getAppContext(), username, jobId, expectedRevision)
  } catch (error) {
    mapCommandError(error)
  }

  executionRuntime().setControl(jobId, 'cancelling')
  abortActiveTurn(jobId, JOB_CANCELLED)
  clearAbortController(jobId)
  cancelJobSandboxTurns(jobId)
  getAppContext().runtimeRegistry.endJobPlanning(jobId)
  executionRuntime().dropRuntime(jobId)
  await clearExecutionLease(jobId)
  void result.runIdToStop

  const mirrored = await mirrorControlStateToLegacy(jobId, result.state)
  const latest = mirrored ?? (await getUserJob(username, jobId))
  if (!latest) throw AppError.internal('Failed to cancel job', 'job.invalid_status')
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job: latest } })
  emitJobEvent(jobId, { event: 'job_done', data: { job: latest } })
  const { stopAndReleaseActiveRun } = await import('./workload-slot-store')
  await stopAndReleaseActiveRun('thread_job', jobId, 'cancelled')
  return attachControlPlaneJobFields(username, latest)
}

async function continueJobViaControlPlane(
  username: string,
  jobId: string,
  expectedRevision: number
): Promise<ThreadJobDto> {
  let result: { id: string; state: string; stateRevision: number }
  try {
    result = await continueJobViaCommand(getAppContext(), username, jobId, expectedRevision)
  } catch (error) {
    mapCommandError(error)
  }

  executionRuntime().setControl(jobId, 'running')
  const mirrored = await mirrorControlStateToLegacy(jobId, result.state, { lastError: null })
  const afterMirror = mirrored ?? (await getUserJob(username, jobId))
  if (!afterMirror) throw AppError.internal('Failed to continue job', 'job.invalid_status')

  if (result.state === 'execution_queued' || result.state === 'planning_queued') {
    const claim = await claimJobSlotOrEnqueue(username, jobId)
    if (claim === 'claimed') {
      const leased = acquireExecutionLease(username, jobId)
      if (leased) {
        await updateJobRowForSnapshot(jobId, { status: 'running', lastError: null })
        await requestJobExecutionResume(username, jobId)
      }
    }
  }

  const latest = (await getUserJob(username, jobId)) ?? afterMirror
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job: latest } })
  return attachControlPlaneJobFields(username, latest)
}

async function restartJobViaControlPlane(
  username: string,
  jobId: string,
  expectedRevision: number
): Promise<ThreadJobDto> {
  let result: { id: string; state: string; stateRevision: number }
  try {
    result = await restartJobViaCommand(getAppContext(), username, jobId, expectedRevision)
  } catch (error) {
    mapCommandError(error)
  }

  executionRuntime().setControl(jobId, 'running')
  const mirrored = await mirrorControlStateToLegacy(jobId, result.state, { lastError: null })
  const afterMirror = mirrored ?? (await getUserJob(username, jobId))
  if (!afterMirror) throw AppError.internal('Failed to restart job', 'job.invalid_status')

  if (result.state === 'execution_queued') {
    const claim = await claimJobSlotOrEnqueue(username, jobId)
    if (claim === 'claimed') {
      const leased = await acquireExecutionLease(username, jobId)
      if (leased) {
        await updateJobRowForSnapshot(jobId, { status: 'running', lastError: null })
        await requestJobExecutionResume(username, jobId)
      }
    }
  }

  const latest = (await getUserJob(username, jobId)) ?? afterMirror
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job: latest } })
  return attachControlPlaneJobFields(username, latest)
}

export async function pauseJob(username: string, jobId: string): Promise<ThreadJobDto> {
  const controlJob = getAuthoritativeControlJob(jobId, username)
  if (controlJob) {
    return pauseJobViaControlPlane(username, jobId, controlJob.stateRevision)
  }

  const pausedError = JOB_PAUSED.toDto()

  const job = await getUserJob(username, jobId)
  if (!job) throw AppError.notFound('Job not found', 'job.not_found')

  if (isPlanningJobStatus(job.status)) {
    const registry = getAppContext().runtimeRegistry
    if (registry.isJobPlanning(jobId)) {
      registry.setPlanningControl(jobId, 'paused')
      const planProgress = {
        ...job.planProgress,
        phase: 'planning' as const,
        status: 'running' as const,
        progressCode: 'plan.pausing' as const,
        progressParams: null,
        message: null
      }
      const updated = await updateJobRow(jobId, { planProgress, lastError: pausedError })
      if (!updated) throw AppError.internal('Failed to pause job', 'job.invalid_status')
      emitJobEvent(jobId, { event: 'plan_progress', data: { planProgress } })
      emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
      return updated
    }

    const planProgress = {
      ...job.planProgress,
      phase: 'idle' as const,
      status: 'pending' as const,
      progressCode: 'plan.pending' as const,
      progressParams: null,
      message: null
    }
    const updated = await updateJobRow(jobId, {
      planProgress,
      lastError: pausedError
    })
    if (!updated) throw AppError.internal('Failed to pause job', 'job.invalid_status')
    emitJobEvent(jobId, { event: 'plan_progress', data: { planProgress } })
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
    return updated
  }

  if (!['plan_ready', 'running', 'paused', 'pending'].includes(job.status)) {
    throw AppError.badRequest(`Job status ${job.status} cannot be paused`, 'job.invalid_status', {
      status: job.status
    })
  }

  if (job.status === 'pending') {
    const updated = await updateJobRowForSnapshot(jobId, {
      status: 'paused',
      lastError: pausedError
    })
    if (!updated) throw AppError.internal('Failed to pause job', 'job.invalid_status')
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
    return updated
  }

  if (job.status === 'running') {
    executionRuntime().setControl(jobId, 'paused')
    const updated = await updateJobRowForSnapshot(jobId, { status: 'pausing' })
    if (!updated) throw AppError.internal('Failed to pause job', 'job.invalid_status')
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
    abortActiveTurn(jobId, JOB_PAUSED)
    cancelJobSandboxTurns(jobId)
    return updated
  }

  executionRuntime().setControl(jobId, 'paused')
  abortActiveTurn(jobId, JOB_PAUSED)
  clearAbortController(jobId)
  cancelJobSandboxTurns(jobId)

  const updated = await updateJobRowForSnapshot(jobId, {
    status: 'paused',
    lastError: pausedError
  })
  if (!updated) throw AppError.internal('Failed to pause job', 'job.invalid_status')
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })

  const { stopAndReleaseActiveRun } = await import('./workload-slot-store')
  await stopAndReleaseActiveRun('thread_job', jobId, 'paused')
  return updated
}

export async function resumePausedJob(username: string, jobId: string): Promise<ThreadJobDto> {
  const controlJob = getAuthoritativeControlJob(jobId, username)
  if (controlJob) {
    return continueJobViaControlPlane(username, jobId, controlJob.stateRevision)
  }

  const job = await getUserJob(username, jobId)
  if (!job) throw AppError.notFound('Job not found', 'job.not_found')
  if (job.status !== 'paused' && job.status !== 'pausing') {
    throw AppError.badRequest('Only paused jobs can be resumed', 'job.invalid_status', {
      status: job.status
    })
  }
  if (job.status === 'pausing') {
    executionRuntime().setControl(jobId, 'running')
    const updated = await updateJobRowForSnapshot(jobId, { status: 'running' })
    if (!updated) throw AppError.internal('Failed to resume job', 'job.invalid_status')
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
    return updated
  }
  return continueJobExecution(username, jobId, job)
}

async function waitForJobLoopIdle(jobId: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isJobExecuting(jobId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !isJobExecuting(jobId)
}

async function requestJobExecutionResume(username: string, jobId: string): Promise<void> {
  if (isJobExecuting(jobId)) {
    cancelJobSandboxTurns(jobId)
    const idle = await waitForJobLoopIdle(jobId)
    if (!idle) {
      throw AppError.badRequest('Job is still stopping; retry later', 'job.invalid_status')
    }
  }
  resumeJobExecution(jobId)
  const { scheduleJobExecution } = await import('./executor')
  scheduleJobExecution(username, jobId)
  if (!isJobExecuting(jobId)) {
    throw AppError.internal('Failed to resume job', 'job.invalid_status')
  }
}

export async function continueFailedJob(username: string, jobId: string): Promise<ThreadJobDto> {
  const controlJob = getAuthoritativeControlJob(jobId, username)
  if (controlJob) {
    return continueJobViaControlPlane(username, jobId, controlJob.stateRevision)
  }

  const job = await getUserJob(username, jobId)
  if (!job) throw AppError.notFound('Job not found', 'job.not_found')
  const state = deriveJobRecoveryState(job)
  if (job.status !== 'failed' || !state.recovery.recoverable) {
    throw AppError.badRequest(
      'Only recoverable failed jobs can be continued',
      'job.invalid_status',
      { status: job.status }
    )
  }

  const plan = await loadPlan(jobId)
  if (!plan?.tasks?.length) {
    throw AppError.badRequest('Job plan is empty', 'job.plan_empty')
  }

  let prepared: ReturnType<typeof prepareContinueFailedExecution>
  try {
    prepared = prepareContinueFailedExecution(job, plan)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const turnErrorCode =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code: string }).code)
        : 'task.execution_failed'
    throw AppError.badRequest(message, turnErrorCode)
  }

  const occupying = await findOccupyingJobId(username, jobId)
  if (occupying) {
    const queued = await updateJobRowForSnapshot(jobId, {
      status: 'pending',
      plan: prepared.plan,
      taskProgress: prepared.taskProgress,
      planProgress: {
        ...defaultPlanProgress(),
        phase: 'plan_ready',
        status: 'pending',
        message: null,
        progressCode: 'execution.pending',
        progressParams: null
      },
      lastError: null
    })
    if (!queued) throw AppError.internal('Failed to continue job', 'job.invalid_status')
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: queued } })
    return queued
  }

  const claim = await claimJobSlotOrEnqueue(username, jobId)
  if (claim === 'queued') {
    const queued = await updateJobRowForSnapshot(jobId, {
      status: 'pending',
      plan: prepared.plan,
      taskProgress: prepared.taskProgress,
      lastError: null
    })
    if (!queued) throw AppError.internal('Failed to continue job', 'job.invalid_status')
    emitJobEvent(jobId, { event: 'task_progress', data: { taskProgress: prepared.taskProgress } })
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: queued } })
    return queued
  }

  const leased = acquireExecutionLease(username, jobId)
  if (!leased) {
    const queued = await updateJobRowForSnapshot(jobId, {
      status: 'pending',
      plan: prepared.plan,
      taskProgress: prepared.taskProgress,
      planProgress: {
        ...defaultPlanProgress(),
        phase: 'plan_ready',
        status: 'pending',
        message: null,
        progressCode: 'execution.pending',
        progressParams: null
      },
      lastError: null
    })
    if (!queued) throw AppError.internal('Failed to continue job', 'job.invalid_status')
    emitJobEvent(jobId, { event: 'task_progress', data: { taskProgress: prepared.taskProgress } })
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: queued } })
    return queued
  }

  executionRuntime().setControl(jobId, 'running')
  const updated = await updateJobRowForSnapshot(jobId, {
    status: 'running',
    plan: prepared.plan,
    taskProgress: prepared.taskProgress,
    lastError: null
  })
  if (!updated) throw AppError.internal('Failed to continue job', 'job.invalid_status')

  await requestJobExecutionResume(username, jobId)

  const latest = await getUserJob(username, jobId)
  if (!latest) throw AppError.internal('Failed to continue job', 'job.invalid_status')
  emitJobEvent(jobId, { event: 'task_progress', data: { taskProgress: prepared.taskProgress } })
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job: latest } })
  return latest
}

export async function resumeJob(username: string, jobId: string): Promise<ThreadJobDto> {
  const job = await getUserJob(username, jobId)
  if (!job) throw AppError.notFound('Job not found', 'job.not_found')
  if (job.status === 'paused') return resumePausedJob(username, jobId)
  if (job.status === 'failed') return continueFailedJob(username, jobId)
  throw AppError.badRequest(
    'Only paused or recoverable failed jobs can be resumed',
    'job.invalid_status',
    { status: job.status }
  )
}

async function continueJobExecution(
  username: string,
  jobId: string,
  job: ThreadJobDto
): Promise<ThreadJobDto> {
  const { progress: recoveredProgress } = prepareInterruptedExecutionResume(job.taskProgress)
  const resumedTaskProgress: TaskProgressDto = {
    ...recoveredProgress,
    phase: 'running',
    status: 'running',
    message: null,
    progressCode: 'execution.resuming',
    progressParams: null
  }

  const occupying = await findOccupyingJobId(username, jobId)
  if (occupying) {
    const queued = await updateJobRowForSnapshot(jobId, {
      status: 'pending',
      planProgress: {
        ...defaultPlanProgress(),
        phase: job.plan?.tasks?.length ? 'plan_ready' : 'idle',
        status: 'pending',
        message: null,
        progressCode: 'execution.pending',
        progressParams: null
      },
      lastError: null
    })
    if (!queued) throw AppError.internal('Failed to resume job', 'job.invalid_status')
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: queued } })
    return queued
  }

  const shouldRun =
    Boolean(job.plan?.tasks?.length) &&
    (job.taskProgress.phase === 'running' ||
      job.taskProgress.tasks.some((t) => t.status !== 'queued'))

  if (shouldRun) {
    const leased = acquireExecutionLease(username, jobId)
    if (!leased) {
      const queued = await updateJobRowForSnapshot(jobId, {
        status: 'pending',
        planProgress: {
          ...defaultPlanProgress(),
          phase: job.plan?.tasks?.length ? 'plan_ready' : 'idle',
          status: 'pending',
          message: null,
          progressCode: 'execution.pending',
          progressParams: null
        },
        taskProgress: resumedTaskProgress,
        lastError: null
      })
      if (!queued) throw AppError.internal('Failed to resume job', 'job.invalid_status')
      emitJobEvent(jobId, { event: 'job_snapshot', data: { job: queued } })
      return queued
    }

    const patched = await updateJobRowForSnapshot(jobId, {
      status: 'running',
      taskProgress: resumedTaskProgress,
      lastError: null
    })
    if (patched) {
      job.taskProgress = resumedTaskProgress
    }

    await requestJobExecutionResume(username, jobId)
    const updated = await getUserJob(username, jobId)
    if (!updated) throw AppError.internal('Failed to resume job', 'job.invalid_status')
    emitJobEvent(jobId, { event: 'task_progress', data: { taskProgress: resumedTaskProgress } })
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
    return updated
  }

  executionRuntime().setControl(jobId, 'running')
  const updated = await updateJobRowForSnapshot(jobId, { status: 'pending' })
  if (!updated) throw AppError.internal('Failed to resume job', 'job.invalid_status')
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
  const { releaseActiveRunOrAdvanceQueue } = await import('./workload-slot-store')
  await releaseActiveRunOrAdvanceQueue(username, 'thread_job', jobId, 'resumed')
  return (await getUserJob(username, jobId)) ?? updated
}

export async function continueJob(username: string, jobId: string): Promise<ThreadJobDto> {
  return continueFailedJob(username, jobId)
}

export async function cancelJob(username: string, jobId: string): Promise<ThreadJobDto> {
  const controlJob = getAuthoritativeControlJob(jobId, username)
  if (controlJob) {
    return cancelJobViaControlPlane(username, jobId, controlJob.stateRevision)
  }

  const job = await getUserJob(username, jobId)
  if (!job) throw AppError.notFound('Job not found', 'job.not_found')
  if (['completed', 'cancelled'].includes(job.status)) {
    throw AppError.badRequest('Job already finished', 'job.already_finished')
  }

  if (isPlanningJobStatus(job.status)) {
    getAppContext().runtimeRegistry.endJobPlanning(jobId)
    cancelJobSandboxTurns(jobId)

    const taskProgress: TaskProgressDto = {
      ...job.taskProgress,
      phase: job.taskProgress.phase === 'idle' ? 'idle' : 'failed',
      status: 'failed',
      message: null,
      progressCode: 'execution.failed',
      progressParams: { reason: 'cancelled' }
    }

    const updated = await updateJobRow(jobId, {
      status: 'cancelled',
      taskProgress,
      lastError: null
    })
    if (!updated) throw AppError.internal('Failed to cancel job', 'job.invalid_status')

    emitJobEvent(jobId, { event: 'task_progress', data: { taskProgress } })
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
    emitJobEvent(jobId, { event: 'job_done', data: { job: updated } })

    const { stopAndReleaseActiveRun } = await import('./workload-slot-store')
    await stopAndReleaseActiveRun('thread_job', jobId, 'cancelled')
    return updated
  }

  executionRuntime().setControl(jobId, 'cancelling')
  abortActiveTurn(jobId, JOB_CANCELLED)
  clearAbortController(jobId)
  cancelJobSandboxTurns(jobId)

  const taskProgress: TaskProgressDto = {
    ...job.taskProgress,
    phase: job.taskProgress.phase === 'idle' ? 'idle' : 'failed',
    status: 'failed',
    message: null,
    progressCode: 'execution.failed',
    progressParams: { reason: 'cancelled' }
  }

  const updated = await updateJobRowForSnapshot(jobId, {
    status: 'cancelled',
    taskProgress,
    lastError: null
  })
  if (!updated) throw AppError.internal('Failed to cancel job', 'job.invalid_status')

  executionRuntime().dropRuntime(jobId)
  await clearExecutionLease(jobId)

  emitJobEvent(jobId, { event: 'task_progress', data: { taskProgress } })
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })
  emitJobEvent(jobId, { event: 'job_done', data: { job: updated } })

  const { stopAndReleaseActiveRun } = await import('./workload-slot-store')
  await stopAndReleaseActiveRun('thread_job', jobId, 'cancelled')
  return updated
}

export async function restartJob(username: string, jobId: string): Promise<ThreadJobDto> {
  const controlJob = getAuthoritativeControlJob(jobId, username)
  if (controlJob) {
    return restartJobViaControlPlane(username, jobId, controlJob.stateRevision)
  }

  const job = await getUserJob(username, jobId)
  if (!job) throw AppError.notFound('Job not found', 'job.not_found')
  if (!['failed', 'cancelled', 'paused'].includes(job.status)) {
    throw AppError.badRequest(
      `Job status ${job.status} cannot be restarted`,
      'job.invalid_status',
      { status: job.status }
    )
  }

  const plan = await loadPlan(jobId)
  if (!plan?.tasks?.length) {
    const { retryJobPlanning } = await import('./service')
    return retryJobPlanning(username, jobId)
  }

  const claim = await claimJobSlotOrEnqueue(username, jobId)
  if (claim === 'queued') {
    const queued = await getUserJob(username, jobId)
    if (!queued) throw AppError.internal('Failed to restart job', 'job.invalid_status')
    return queued
  }

  const taskProgress: TaskProgressDto = {
    phase: 'running',
    status: 'running',
    currentIndex: 0,
    total: plan.tasks.length,
    currentTaskId: null,
    message: null,
    progressCode: 'execution.resuming',
    progressParams: null,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: 'queued',
      abilityCode: task.abilityCode,
      executionStatus: 'queued',
      evidenceStatus: null,
      errorMessage: null,
      coreCode: null
    }))
  }

  const leased = await acquireExecutionLease(username, jobId)
  if (!leased) {
    const queued = await updateJobRowForSnapshot(jobId, {
      status: 'pending',
      planProgress: {
        ...defaultPlanProgress(),
        phase: 'plan_ready',
        status: 'pending',
        message: null,
        progressCode: 'execution.pending',
        progressParams: null
      },
      taskProgress,
      lastError: null
    })
    if (!queued) throw AppError.internal('Failed to restart job', 'job.invalid_status')
    emitJobEvent(jobId, { event: 'job_snapshot', data: { job: queued } })
    return queued
  }

  executionRuntime().setControl(jobId, 'running')

  const updated = await updateJobRowForSnapshot(jobId, {
    taskProgress,
    lastError: null
  })
  if (!updated) throw AppError.internal('Failed to restart job', 'job.invalid_status')

  emitJobEvent(jobId, { event: 'task_progress', data: { taskProgress } })
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })

  await requestJobExecutionResume(username, jobId)
  return updated
}

export async function deleteJob(username: string, jobId: string): Promise<void> {
  const job = await getUserJob(username, jobId)
  if (!job) throw AppError.notFound('Job not found', 'job.not_found')

  if (isJobExecuting(jobId)) {
    executionRuntime().setControl(jobId, 'cancelling')
    abortActiveTurn(jobId, JOB_CANCELLED)
    clearAbortController(jobId)
    cancelJobSandboxTurns(jobId)
    executionRuntime().dropRuntime(jobId)
  }

  await clearExecutionLease(jobId)
  await releaseJobCursorResources(jobId).catch(() => {})

  const ctx = getAppContext()
  const db = getDb()
  const threadId = job.threadId
  const draftMessageId = job.draftMessageId
  await db.delete(threadJobs).where(eq(threadJobs.id, jobId))

  ctx.eventBus.clearJob(jobId)
  await purgeJobFilesystem(ctx.dataDir, threadId, jobId).catch((error) => {
    console.warn('[jobs] failed to purge job filesystem state', jobId, error)
  })

  const { stopAndReleaseActiveRun } = await import('./workload-slot-store')
  await stopAndReleaseActiveRun('thread_job', jobId, 'deleted')

  // Trigger clears threads.active_plan_id; also clear draft linkedPlanId so Unlock UI matches server.
  const { releaseDraftAfterJobDeleted } = await import('./draft-plan')
  await releaseDraftAfterJobDeleted(username, threadId, jobId, draftMessageId).catch((error) => {
    console.warn('[jobs] failed to release draft after job delete', jobId, error)
  })
}

export function markJobExecuting(jobId: string, username?: string): boolean {
  return executionRuntime().tryStartLoop(jobId, username)
}

export async function markJobExecutionDone(jobId: string, _username: string): Promise<void> {
  executionRuntime().endLoop(jobId)
  await clearExecutionLease(jobId)
}

export function createExecutionAbortSignal(jobId: string): AbortSignal {
  const controller = new AbortController()
  attachAbortController(jobId, controller)
  return controller.signal
}

export function newTaskMcpSessionId(): string {
  return `task-mcp-${randomUUID()}`
}
