import type { TaskProgressItemDto, ThreadJobDto } from './types'
import type { GateMilestoneState, GateSliceState } from './execution-gate'
import { pausingAttemptKey } from './recovery-limits'
import { taskErrorFields } from '../turn-errors/store'
import type { TaskProgressDto } from './types'

function findInterruptedTaskId(taskProgress: TaskProgressDto): string | null {
  if (taskProgress.currentTaskId) return taskProgress.currentTaskId
  for (const task of taskProgress.tasks) {
    if (task.status === 'running' || task.executionStatus === 'running') {
      return task.id
    }
  }
  return null
}

function shouldMarkTaskFailedOnJobFailure(task: TaskProgressItemDto): boolean {
  if (task.status === 'completed' || task.status === 'skipped') return false
  if (task.status === 'failed' && task.executionStatus !== 'running') return false
  return (
    task.status === 'running' ||
    task.executionStatus === 'running' ||
    task.executionStatus === 'retry-queued'
  )
}

export function syncTaskProgressForJobFailure(
  taskProgress: TaskProgressDto,
  error: unknown
): TaskProgressDto {
  const { error: turnError, errorMessage } = taskErrorFields(error)
  const taskId = findInterruptedTaskId(taskProgress)
  const tasks = taskProgress.tasks.map((task) => {
    if (!taskId || task.id !== taskId || !shouldMarkTaskFailedOnJobFailure(task)) {
      return { ...task }
    }
    return {
      ...task,
      status: 'failed' as const,
      executionStatus: 'failed' as const,
      error: turnError,
      errorMessage
    }
  })

  return {
    ...taskProgress,
    phase: 'failed',
    status: 'failed',
    currentTaskId: null,
    message: null,
    progressCode: 'execution.failed',
    progressParams: turnError.params ?? (taskId ? { id: taskId } : null),
    tasks
  }
}

export function resetInterruptedRunningTasks(items: TaskProgressItemDto[]): boolean {
  let changed = false
  for (const item of items) {
    if (item.status !== 'running') continue
    item.status = 'queued'
    item.executionStatus = 'queued'
    item.errorMessage = null
    changed = true
  }
  return changed
}

export function resetInterruptedVerificationInProgress(
  progress: Pick<TaskProgressDto, 'slices' | 'milestones'>
): boolean {
  let changed = false
  for (const slice of progress.slices ?? []) {
    if (slice.runtimeStatus !== 'verifying') continue
    slice.runtimeStatus = 'ready-for-verification'
    changed = true
  }
  for (const milestone of progress.milestones ?? []) {
    if (milestone.verificationStatus !== 'verifying') continue
    milestone.verificationStatus = 'ready-for-verification'
    changed = true
  }
  return changed
}

export function resetInterruptedGateVerification(
  slices: GateSliceState[],
  milestones: GateMilestoneState[]
): boolean {
  let changed = false
  for (const slice of slices) {
    if (slice.runtimeStatus !== 'verifying') continue
    slice.runtimeStatus = 'ready-for-verification'
    changed = true
  }
  for (const milestone of milestones) {
    if (milestone.verificationStatus !== 'verifying') continue
    milestone.verificationStatus = 'ready-for-verification'
    changed = true
  }
  return changed
}

export function prepareInterruptedExecutionResume(taskProgress: TaskProgressDto): {
  progress: TaskProgressDto
  recovered: boolean
} {
  const interruptedTaskId = findInterruptedTaskId(taskProgress)
  const progress: TaskProgressDto = {
    ...taskProgress,
    currentTaskId: taskProgress.currentTaskId ?? interruptedTaskId,
    tasks: taskProgress.tasks.map((task) => ({ ...task })),
    slices: taskProgress.slices?.map((slice) => ({ ...slice })),
    milestones: taskProgress.milestones?.map((milestone) => ({ ...milestone }))
  }
  const tasksRecovered = resetInterruptedRunningTasks(progress.tasks)
  const verifyRecovered = resetInterruptedVerificationInProgress(progress)
  // Drop stale in-flight slice markers so a stopped job does not render as "执行中".
  let sliceCleared = false
  for (const slice of progress.slices ?? []) {
    if (slice.runtimeStatus !== 'running') continue
    slice.runtimeStatus = null
    sliceCleared = true
  }
  return { progress, recovered: tasksRecovered || verifyRecovered || sliceCleared }
}

export function readPausingAttempt(progress: TaskProgressDto, jobId: string): number {
  return progress.repairGenerations?.[pausingAttemptKey(jobId)] ?? 0
}

export function withPausingAttempt(
  progress: TaskProgressDto,
  jobId: string,
  attempt: number
): TaskProgressDto {
  return {
    ...progress,
    repairGenerations: {
      ...(progress.repairGenerations ?? {}),
      [pausingAttemptKey(jobId)]: attempt
    }
  }
}

export type StaleExecutionJobAction = 'noop' | 'finalize-user-pause' | 'resume-running'

/**
 * Human-dependency pause must never be treated as restart-interrupted.
 * Task evidence remains for Continue / UI; auto-resume no longer uses it.
 */
export function isHumanDependencyPause(job: ThreadJobDto): boolean {
  if (job.suspensionKind === 'human_dependency') return true
  return job.taskProgress.tasks.some(
    (task) =>
      task.recoveryAction === 'pause-human' || task.blockerKind === 'dependency-human'
  )
}

/**
 * P7: long-term restart-paused heuristics removed.
 * Legacy rows were one-time promoted to `pending` by migration 039.
 * Structured suspensionKind is authoritative; paused never auto-resumes.
 */
export function isRestartInterruptedPause(_job: ThreadJobDto): boolean {
  return false
}

/** Decide how to reconcile a thread job whose in-memory execution loop is gone. */
export function resolveStaleExecutionJobAction(
  job: Pick<
    ThreadJobDto,
    'status' | 'taskProgress' | 'lastError' | 'suspensionKind' | 'recoveryReason'
  >
): StaleExecutionJobAction {
  if (job.status === 'pausing') return 'finalize-user-pause'
  if (job.status === 'paused') return 'noop'
  if (job.status === 'running') return 'resume-running'
  return 'noop'
}
