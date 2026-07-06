import type { TaskProgressDto, TaskProgressItemDto, ThreadJobDto } from './types'
import type { SavedJobPlan } from '../planner/plan-types'
import type { TurnErrorCode } from '../../shared/turn-errors/codes'
import { deriveJobRecoveryState } from '../../shared/job-recovery-state'
import { coerceTurnErrorField } from '../../shared/turn-errors/storage'
import { createTurnError } from '../../shared/turn-errors/turn-error.ts'
import { prepareInterruptedExecutionResume } from './execution-recovery'
import type { TaskEvidencePacket } from './task-blocker/types'
import {
  applyTaskInfraRetryItem,
  applyTaskPrepRecoveryItem,
  applyTaskRepairRecoveryItem,
  applyTaskRecoveryGenerationForTask,
  injectPrepTasksForRecovery,
  injectRepairTasksForRecovery,
  resetTaskItemForManualRetry,
  resolveTaskRecoveryAction
} from './task-blocker'

function clonePlan(plan: SavedJobPlan): SavedJobPlan {
  return structuredClone(plan)
}

function appendQueuedRepairItems(
  plan: SavedJobPlan,
  items: TaskProgressItemDto[],
  newTaskIds: string[]
): TaskProgressItemDto[] {
  const existing = new Set(items.map((item) => item.id))
  const next = [...items]
  for (const taskId of newTaskIds) {
    if (existing.has(taskId)) continue
    const flat = plan.tasks.find((task) => task.id === taskId)
    if (!flat) continue
    next.push({
      id: flat.id,
      title: flat.title,
      status: 'queued',
      abilityCode: flat.abilityCode,
      executionStatus: 'queued',
      evidenceStatus: null,
      evidence: null,
      errorMessage: null,
      coreCode: flat.coreCode ?? null
    })
    existing.add(taskId)
  }
  return next
}

const MANUAL_CONTINUE_ERROR_CODES = new Set<TurnErrorCode>([
  'turn.cancelled',
  'sandbox.turn.cancelled',
  'job.cancelled',
  'job.paused',
  'task.execution_failed',
  'turn.timed_out',
  'turn.incomplete',
  'turn.empty_reply'
])

function readTaskErrorCode(task: TaskProgressItemDto): TurnErrorCode | null {
  if (task.error?.code) return task.error.code
  return coerceTurnErrorField(task.errorMessage)?.code ?? null
}

function isExecutionFailureRetryable(task: TaskProgressItemDto): boolean {
  if (task.status !== 'failed') return false
  if (task.executionStatus === 'blocked') return false
  if (task.evidence?.recovery?.action === 'terminal-fail') return false
  if (task.evidence?.recovery?.action === 'pause-human') return false
  if (task.executionStatus === 'failed') return true
  const code = readTaskErrorCode(task)
  return code !== null && MANUAL_CONTINUE_ERROR_CODES.has(code)
}

function prepareManualTaskRetry(
  plan: SavedJobPlan,
  taskProgress: TaskProgressDto,
  failedTaskId: string
): { plan: SavedJobPlan; taskProgress: TaskProgressDto } {
  const items = resetTaskItemForManualRetry(taskProgress.tasks, failedTaskId)
  return {
    plan,
    taskProgress: {
      ...taskProgress,
      tasks: items,
      phase: 'running',
      status: 'running',
      message: null,
      progressCode: 'execution.continuing_task',
      progressParams: { id: failedTaskId },
      currentTaskId: null,
      total: items.length
    }
  }
}

function syntheticPacket(task: TaskProgressItemDto): TaskEvidencePacket {
  if (task.evidence) return task.evidence
  return {
    status: 'blocked',
    summary: task.errorMessage ?? 'task failed',
    changedFiles: [],
    evidence: [task.errorMessage ?? 'task failed'],
    validation: { ran: false, outcome: 'skipped' },
    blockers: task.errorMessage ? [task.errorMessage] : ['task failed']
  }
}

export function prepareContinueFailedExecution(
  job: ThreadJobDto,
  plan: SavedJobPlan
): { plan: SavedJobPlan; taskProgress: TaskProgressDto } {
  const state = deriveJobRecoveryState(job)
  if (!state.recovery.recoverable) {
    throw createTurnError('task.execution_failed', {
      detail: 'Job failure is not recoverable'
    })
  }

  const currentPlan = clonePlan(plan)
  let taskProgress: TaskProgressDto = {
    ...job.taskProgress,
    tasks: job.taskProgress.tasks.map((task) => ({ ...task }))
  }

  const failedTaskId = state.recovery.failedTaskId

  if (!failedTaskId && state.recovery.reason === 'workflow_deadlock') {
    const { progress } = prepareInterruptedExecutionResume(taskProgress)
    return {
      plan: currentPlan,
      taskProgress: {
        ...progress,
        phase: 'running',
        status: 'running',
        message: null,
        progressCode: 'execution.resuming',
        progressParams: null,
        currentTaskId: null
      }
    }
  }

  if (!failedTaskId) {
    throw createTurnError('task.execution_failed', {
      detail: 'No failed subtask to continue'
    })
  }

  const task = taskProgress.tasks.find((item) => item.id === failedTaskId)
  if (!task)
    throw createTurnError('task.execution_failed', {
      detail: `Failed subtask ${failedTaskId} not found`
    })

  if (
    task.executionStatus === 'waiting-on-repair' ||
    task.executionStatus === 'waiting-on-dependency'
  ) {
    const { progress } = prepareInterruptedExecutionResume(taskProgress)
    return {
      plan: currentPlan,
      taskProgress: {
        ...progress,
        phase: 'running',
        status: 'running',
        message: null,
        progressCode: 'execution.resuming',
        progressParams: null,
        currentTaskId: null
      }
    }
  }

  const failureKind = state.failure.kind
  if (failureKind === 'human_blocked') {
    throw createTurnError('task.terminal_failure', {
      params: { taskId: failedTaskId },
      detail: state.failure.message ?? 'Human intervention required'
    })
  }

  if (isExecutionFailureRetryable(task)) {
    return prepareManualTaskRetry(currentPlan, taskProgress, failedTaskId)
  }

  if (failureKind === 'infra_retryable' || task.executionStatus === 'retry-queued') {
    const items = resetTaskItemForManualRetry(taskProgress.tasks, failedTaskId).map((item) =>
      item.id === failedTaskId
        ? { ...item, status: 'queued' as const, executionStatus: 'retry-queued' }
        : item
    )
    return {
      plan: currentPlan,
      taskProgress: {
        ...taskProgress,
        tasks: items,
        phase: 'running',
        status: 'running',
        message: null,
        progressCode: 'execution.recovery_infra_retry',
        progressParams: { id: failedTaskId },
        currentTaskId: null,
        total: items.length
      }
    }
  }

  const packet = syntheticPacket(task)
  const recovery = resolveTaskRecoveryAction({
    packet,
    taskId: failedTaskId,
    taskProgress
  })

  if (recovery.action === 'terminal-fail' || recovery.action === 'pause-human') {
    throw createTurnError('task.terminal_failure', {
      params: { taskId: failedTaskId },
      detail: recovery.message
    })
  }

  if (recovery.action === 'infra-retry') {
    const items = applyTaskInfraRetryItem(
      taskProgress.tasks,
      failedTaskId,
      packet,
      recovery.classification,
      recovery.attempt,
      recovery.maxAttempts
    )
    taskProgress = applyTaskRecoveryGenerationForTask(
      { ...taskProgress, tasks: items },
      failedTaskId,
      recovery
    )
    return {
      plan: currentPlan,
      taskProgress: {
        ...taskProgress,
        phase: 'running',
        status: 'running',
        message: null,
        progressCode: 'execution.recovery_infra_retry',
        progressParams: {
          id: failedTaskId,
          attempt: recovery.attempt,
          maxAttempts: recovery.maxAttempts
        },
        currentTaskId: null
      }
    }
  }

  if (recovery.action === 'inject-prep') {
    const newTaskIds = injectPrepTasksForRecovery({
      plan: currentPlan,
      blockedTaskId: failedTaskId,
      packet,
      attempt: recovery.attempt
    })
    let items = appendQueuedRepairItems(currentPlan, taskProgress.tasks, newTaskIds)
    items = applyTaskPrepRecoveryItem(
      items,
      failedTaskId,
      packet,
      recovery.classification,
      recovery.attempt,
      recovery.maxAttempts
    )
    taskProgress = applyTaskRecoveryGenerationForTask(
      { ...taskProgress, tasks: items },
      failedTaskId,
      recovery
    )
    return {
      plan: currentPlan,
      taskProgress: {
        ...taskProgress,
        tasks: items,
        total: items.length,
        phase: 'running',
        status: 'running',
        message: null,
        progressCode: 'execution.recovery_prep_injected',
        progressParams: {
          id: failedTaskId,
          attempt: recovery.attempt,
          maxAttempts: recovery.maxAttempts
        },
        currentTaskId: null
      }
    }
  }

  if (recovery.action === 'inject-repair') {
    const newTaskIds = injectRepairTasksForRecovery({
      plan: currentPlan,
      blockedTaskId: failedTaskId,
      packet,
      attempt: recovery.attempt
    })
    let items = appendQueuedRepairItems(currentPlan, taskProgress.tasks, newTaskIds)
    items = applyTaskRepairRecoveryItem(
      items,
      failedTaskId,
      packet,
      recovery.classification,
      recovery.attempt,
      recovery.maxAttempts
    )
    taskProgress = applyTaskRecoveryGenerationForTask(
      { ...taskProgress, tasks: items },
      failedTaskId,
      recovery
    )
    return {
      plan: currentPlan,
      taskProgress: {
        ...taskProgress,
        tasks: items,
        total: items.length,
        phase: 'running',
        status: 'running',
        message: null,
        progressCode: 'execution.recovery_repair_injected',
        progressParams: {
          id: failedTaskId,
          attempt: recovery.attempt,
          maxAttempts: recovery.maxAttempts
        },
        currentTaskId: null
      }
    }
  }

  throw createTurnError('task.execution_failed', { detail: 'Unable to continue execution' })
}
