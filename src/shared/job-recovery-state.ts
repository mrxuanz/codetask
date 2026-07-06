import type { TaskBlockerKind } from './contracts/evidence'
import type { TaskProgressItemDto, ThreadJobDto, ThreadJobStatus } from './contracts/jobs'

const MAX_INFRA_RETRIES = 3
const MAX_TASK_PREP_GENERATIONS = 3
const MAX_TASK_REPAIR_GENERATIONS = 3

export type JobLifecycle = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export type FailureKind =
  | 'infra_retryable'
  | 'task_repairable'
  | 'dependency_missing'
  | 'human_blocked'
  | 'terminal'

export type JobNextAction =
  | 'continue'
  | 'retry_failed_task'
  | 'restart'
  | 'cancel'
  | 'delete'
  | 'pause'

export type JobAvailableAction =
  | 'continue'
  | 'retry_failed_task'
  | 'restart'
  | 'cancel'
  | 'delete'
  | 'pause'

export interface ExecutionProgressDto {
  completedCount: number
  total: number
  currentTaskId: string | null
  failedTaskId: string | null
  percentage: number
  phase: ThreadJobDto['taskProgress']['phase']
  message: string | null
}

export interface JobFailureDto {
  kind: FailureKind | null
  message: string | null
  taskId: string | null
}

export interface JobRecoveryDto {
  recoverable: boolean
  reason: string | null
  nextAction: JobNextAction | null
  failedTaskId: string | null
  autoRetryAttempt: number
  maxAutoRetryAttempts: number
  repairGeneration: number
  maxRepairGenerations: number
}

export interface JobRecoveryStateFields {
  lifecycle: JobLifecycle
  execution: ExecutionProgressDto
  failure: JobFailureDto
  recovery: JobRecoveryDto
  availableActions: JobAvailableAction[]
}

import type { TurnErrorCode, TurnErrorDto } from './contracts/turn-errors'
import { coerceTurnErrorField } from './turn-errors/storage.ts'

const WORKFLOW_PROGRESS_BY_TURN_CODE = {
  'workflow.deadlock': 'execution.workflow_deadlock',
  'workflow.failed_block': 'execution.workflow_failed_block'
} as const

function matchesWorkflowCode(
  input: TurnErrorDto | string | null | undefined,
  code: 'workflow.deadlock' | 'workflow.failed_block'
): boolean {
  const dto = typeof input === 'object' && input ? input : coerceTurnErrorField(input)
  return dto?.code === code
}

function matchesWorkflowProgressCode(
  progressCode: string | null | undefined,
  code: 'workflow.deadlock' | 'workflow.failed_block'
): boolean {
  return progressCode === WORKFLOW_PROGRESS_BY_TURN_CODE[code]
}

function resolveLifecycle(status: ThreadJobStatus): JobLifecycle {
  if (status === 'running') return 'running'
  if (status === 'paused') return 'paused'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'pending'
}

function countCompletedTasks(tasks: TaskProgressItemDto[]): number {
  return tasks.filter((task) => task.status === 'completed' || task.status === 'skipped').length
}

function isWorkflowDeadlockOnly(job: Pick<ThreadJobDto, 'taskProgress' | 'lastError'>): boolean {
  const tasks = job.taskProgress.tasks
  if (tasks.some((task) => task.status === 'failed')) return false
  if (matchesWorkflowCode(job.lastError, 'workflow.deadlock')) return true
  return matchesWorkflowProgressCode(job.taskProgress.progressCode, 'workflow.deadlock')
}

function isTerminalTask(task: TaskProgressItemDto): boolean {
  return task.evidence?.recovery?.action === 'terminal-fail'
}

function isHumanBlockedTask(task: TaskProgressItemDto): boolean {
  const kind = task.evidence?.recovery?.kind ?? task.evidence?.blockerKind
  return kind === 'dependency-human' || task.evidence?.recovery?.action === 'pause-human'
}

function isRecoverableTask(task: TaskProgressItemDto, job?: Pick<ThreadJobDto, 'status'>): boolean {
  if (job && isInterruptedFailedJobTask(job, task)) return true
  if (isTerminalTask(task) || isHumanBlockedTask(task)) return false
  if (task.executionStatus === 'retry-queued') return true
  if (task.executionStatus === 'waiting-on-repair') return true
  if (task.executionStatus === 'waiting-on-dependency') return true
  if (task.status === 'failed') return true
  return false
}

function isInterruptedFailedJobTask(
  job: Pick<ThreadJobDto, 'status'>,
  task: TaskProgressItemDto
): boolean {
  if (job.status !== 'failed') return false
  if (task.status === 'completed' || task.status === 'skipped') return false
  if (isTerminalTask(task) || isHumanBlockedTask(task)) return false
  if (task.status !== 'running' && task.executionStatus !== 'running') return false
  return Boolean(task.errorMessage || task.error)
}

function findPrimaryRecoverableTask(
  tasks: TaskProgressItemDto[],
  job?: Pick<ThreadJobDto, 'status'>
): TaskProgressItemDto | null {
  for (const task of tasks) {
    if (!isRecoverableTask(task, job)) continue
    return task
  }
  return null
}

function findRetryableTask(
  tasks: TaskProgressItemDto[],
  job?: Pick<ThreadJobDto, 'status'>
): TaskProgressItemDto | null {
  if (job?.status === 'failed') {
    for (const task of tasks) {
      if (isInterruptedFailedJobTask(job, task)) return task
    }
  }
  for (const task of tasks) {
    if (task.status === 'failed') return task
    if (task.executionStatus === 'retry-queued' || task.executionStatus === 'waiting-on-repair') {
      return task
    }
  }
  return null
}

function mapBlockerToFailureKind(
  kind: TaskBlockerKind | undefined,
  task: TaskProgressItemDto
): FailureKind {
  if (isTerminalTask(task)) return 'terminal'
  if (isHumanBlockedTask(task)) return 'human_blocked'
  if (task.executionStatus === 'retry-queued') return 'infra_retryable'
  if (task.executionStatus === 'waiting-on-dependency') return 'dependency_missing'
  if (task.executionStatus === 'waiting-on-repair') return 'task_repairable'
  switch (kind) {
    case 'infra':
      return 'infra_retryable'
    case 'dependency-prep':
      return 'dependency_missing'
    case 'implementation':
      return 'task_repairable'
    case 'dependency-human':
      return 'human_blocked'
    default:
      return 'terminal'
  }
}

function readTaskInfraAttempt(job: Pick<ThreadJobDto, 'taskProgress'>, taskId: string): number {
  return job.taskProgress.repairGenerations?.[`task-infra:${taskId}`] ?? 0
}

function readTaskRepairAttempt(
  job: Pick<ThreadJobDto, 'taskProgress'>,
  taskId: string,
  failureKind: FailureKind | null
): { attempt: number; max: number } {
  if (failureKind === 'dependency_missing') {
    return {
      attempt: job.taskProgress.repairGenerations?.[`task-prep:${taskId}`] ?? 0,
      max: MAX_TASK_PREP_GENERATIONS
    }
  }
  if (failureKind === 'task_repairable') {
    return {
      attempt: job.taskProgress.repairGenerations?.[`task-repair:${taskId}`] ?? 0,
      max: MAX_TASK_REPAIR_GENERATIONS
    }
  }
  return { attempt: 0, max: MAX_TASK_REPAIR_GENERATIONS }
}

function readTaskErrorCode(task: TaskProgressItemDto): TurnErrorCode | null {
  if (task.error?.code) return task.error.code
  return coerceTurnErrorField(task.errorMessage)?.code ?? null
}

function resolveRecoveryReason(input: {
  lifecycle: JobLifecycle
  task: TaskProgressItemDto | null
  failureKind: FailureKind | null
  workflowDeadlock: boolean
}): string | null {
  if (input.lifecycle === 'paused') return 'user_paused'
  if (input.workflowDeadlock) return 'workflow_deadlock'
  if (!input.task) {
    if (input.lifecycle === 'failed') {
      return input.failureKind === 'terminal' ? 'terminal_exhausted' : 'job_failed'
    }
    return null
  }

  const recoveryAction = input.task.evidence?.recovery?.action
  if (recoveryAction === 'infra-retry' || input.failureKind === 'infra_retryable') {
    return 'task_infra_failure'
  }
  if (recoveryAction === 'inject-prep' || input.failureKind === 'dependency_missing') {
    return 'task_dependency_missing'
  }
  if (recoveryAction === 'inject-repair' || input.failureKind === 'task_repairable') {
    return 'task_implementation_failed'
  }
  if (input.failureKind === 'human_blocked') return 'human_dependency_blocked'
  if (input.failureKind === 'terminal') return 'terminal_exhausted'

  const code = readTaskErrorCode(input.task)
  if (code === 'task.evidence_timeout' || code === 'task.evidence_missing') {
    return 'task_result_timeout'
  }
  if (code === 'workflow.failed_block') return 'workflow_failed_block'
  return 'task_failed'
}

function resolveNextAction(input: {
  lifecycle: JobLifecycle
  recoverable: boolean
  failureKind: FailureKind | null
  retryableTaskId: string | null
}): JobNextAction | null {
  if (input.lifecycle === 'paused' && input.recoverable) return 'continue'
  if (input.lifecycle === 'failed' && input.recoverable) {
    if (input.failureKind === 'infra_retryable' && input.retryableTaskId) {
      return 'retry_failed_task'
    }
    return 'continue'
  }
  if (input.retryableTaskId) return 'retry_failed_task'
  if (input.lifecycle === 'running' || input.lifecycle === 'pending') return null
  if (input.lifecycle === 'failed' || input.lifecycle === 'cancelled') return 'restart'
  return null
}

function deriveAvailableActions(input: {
  lifecycle: JobLifecycle
  status: ThreadJobStatus
  recoverable: boolean
  retryableTaskId: string | null
}): JobAvailableAction[] {
  const actions: JobAvailableAction[] = []

  if (input.lifecycle === 'running' || input.lifecycle === 'pending') {
    actions.push('cancel')
    if (input.status === 'running' || input.status === 'pending') {
      actions.push('pause')
    }
    actions.push('delete')
  }

  if (input.lifecycle === 'paused') {
    actions.push('continue', 'restart', 'delete')
    return actions
  }

  if (input.lifecycle === 'failed') {
    if (input.recoverable) actions.push('continue')
    if (input.retryableTaskId) actions.push('retry_failed_task')
    actions.push('restart', 'delete')
    return actions
  }

  if (input.lifecycle === 'completed') {
    actions.push('delete')
    return actions
  }

  if (input.lifecycle === 'cancelled') {
    actions.push('restart', 'delete')
    return actions
  }

  if (!actions.includes('delete')) actions.push('delete')
  return actions
}

function isJobRecoverable(
  job: Pick<ThreadJobDto, 'status' | 'taskProgress' | 'lastError'>
): boolean {
  if (job.status === 'paused') return true
  if (job.status !== 'failed') return false
  if (isWorkflowDeadlockOnly(job)) return true
  return findPrimaryRecoverableTask(job.taskProgress.tasks, job) !== null
}

export function deriveJobRecoveryState(
  job: Pick<ThreadJobDto, 'status' | 'lastError' | 'taskProgress'>
): JobRecoveryStateFields {
  const lifecycle = resolveLifecycle(job.status)
  const tasks = job.taskProgress.tasks
  const completedCount = countCompletedTasks(tasks)
  const total = job.taskProgress.total || tasks.length
  const percentage = total > 0 ? Math.round((completedCount / total) * 100) : 0
  const workflowDeadlock = isWorkflowDeadlockOnly(job)
  const recoverableTask = findPrimaryRecoverableTask(tasks, job)
  const retryableTask = findRetryableTask(tasks, job)
  const recoverable = isJobRecoverable(job)

  const failedTaskId = recoverableTask?.id ?? retryableTask?.id ?? null
  const blockerKind =
    recoverableTask?.evidence?.recovery?.kind ?? recoverableTask?.evidence?.blockerKind
  const failureKind: FailureKind | null =
    lifecycle === 'failed' || lifecycle === 'paused'
      ? workflowDeadlock
        ? 'infra_retryable'
        : recoverableTask
          ? mapBlockerToFailureKind(blockerKind, recoverableTask)
          : lifecycle === 'failed'
            ? 'terminal'
            : null
      : null

  const repairCounters = failedTaskId
    ? readTaskRepairAttempt(job, failedTaskId, failureKind)
    : { attempt: 0, max: MAX_TASK_REPAIR_GENERATIONS }

  const recovery: JobRecoveryDto = {
    recoverable,
    reason: resolveRecoveryReason({
      lifecycle,
      task: recoverableTask,
      failureKind,
      workflowDeadlock
    }),
    nextAction: resolveNextAction({
      lifecycle,
      recoverable,
      failureKind,
      retryableTaskId: retryableTask?.id ?? null
    }),
    failedTaskId,
    autoRetryAttempt: failedTaskId ? readTaskInfraAttempt(job, failedTaskId) : 0,
    maxAutoRetryAttempts: MAX_INFRA_RETRIES,
    repairGeneration: repairCounters.attempt,
    maxRepairGenerations: repairCounters.max
  }

  const lastErrorDto =
    typeof job.lastError === 'object' && job.lastError
      ? job.lastError
      : coerceTurnErrorField(job.lastError)

  const failure: JobFailureDto = {
    kind: failureKind,
    message:
      recoverableTask?.error?.message ??
      recoverableTask?.errorMessage ??
      lastErrorDto?.message ??
      null,
    taskId: failedTaskId
  }

  const execution: ExecutionProgressDto = {
    completedCount,
    total,
    currentTaskId: job.taskProgress.currentTaskId ?? null,
    failedTaskId,
    percentage,
    phase: job.taskProgress.phase,
    message: null
  }

  const availableActions = deriveAvailableActions({
    lifecycle,
    status: job.status,
    recoverable,
    retryableTaskId:
      lifecycle === 'failed' || lifecycle === 'paused' ? (retryableTask?.id ?? null) : null
  })

  return {
    lifecycle,
    execution,
    failure,
    recovery,
    availableActions
  }
}

export function enrichJobWithRecoveryState<T extends ThreadJobDto>(job: T): T {
  const derived = deriveJobRecoveryState(job)
  return { ...job, ...derived }
}

export function jobHasAction(
  job: Pick<ThreadJobDto, 'availableActions'> | null | undefined,
  action: JobAvailableAction
): boolean {
  return job?.availableActions?.includes(action) ?? false
}
