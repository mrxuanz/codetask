import type { TaskProgressDto, TaskProgressItemDto, ThreadJobDto } from './types'
import type { GateMilestoneState, GateSliceState } from './execution-gate'
import { taskErrorFields } from '../turn-errors/store'

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
  const progress: TaskProgressDto = {
    ...taskProgress,
    tasks: taskProgress.tasks.map((task) => ({ ...task })),
    slices: taskProgress.slices?.map((slice) => ({ ...slice })),
    milestones: taskProgress.milestones?.map((milestone) => ({ ...milestone }))
  }
  const tasksRecovered = resetInterruptedRunningTasks(progress.tasks)
  const verifyRecovered = resetInterruptedVerificationInProgress(progress)
  return { progress, recovered: tasksRecovered || verifyRecovered }
}

/** Paused by restart reconcile — not an explicit user pause (job.paused). */
export function isRestartInterruptedPause(job: ThreadJobDto): boolean {
  if (job.status !== 'paused') return false
  if (job.taskProgress.phase !== 'running') return false
  if (job.lastError?.code === 'job.paused') return false

  const tasks = job.taskProgress.tasks
  return (
    job.taskProgress.currentIndex > 0 ||
    tasks.some(
      (task) =>
        task.status !== 'queued' ||
        task.executionStatus === 'running' ||
        task.executionStatus === 'retry-queued'
    ) ||
    (job.taskProgress.slices?.some((slice) => slice.runtimeStatus != null) ?? false)
  )
}
