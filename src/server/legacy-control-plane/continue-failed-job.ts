import type { TaskProgressDto, TaskProgressItemDto, ThreadJobDto } from './types'
import type { SavedJobPlan } from '../planner/plan-types'
import type { TurnErrorCode } from '../../shared/turn-errors/codes'
import { deriveJobRecoveryState, isGateFailureProgressCode } from '../../shared/job-recovery-state'
import { coerceTurnErrorField } from '../../shared/turn-errors/storage'
import { createTurnError } from '../../shared/turn-errors/turn-error.ts'
import { prepareInterruptedExecutionResume } from './execution-recovery'
import { repairGenerationKey } from './repair-tasks'
import type { TaskEvidencePacket } from './task-blocker/types'
import {
  applyTaskInfraRetryItem,
  applyTaskPrepRecoveryItem,
  applyTaskRepairRecoveryItem,
  applyTaskRecoveryGenerationForTask,
  injectPrepTasksForRecovery,
  injectRepairTasksForRecovery,
  resetTaskItemForManualRetry,
  resetTaskRecoveryCounters,
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
  'task.evidence_timeout',
  'task.evidence_missing',
  'task.infra_retry',
  'task.infra_retry_exhausted',
  'task.terminal_failure',
  'turn.timed_out',
  'turn.incomplete',
  'turn.empty_reply'
])

function readTaskErrorCode(task: TaskProgressItemDto): TurnErrorCode | null {
  if (task.error?.code) return task.error.code
  return coerceTurnErrorField(task.errorMessage)?.code ?? null
}

function isHumanBlockedTask(task: TaskProgressItemDto): boolean {
  const kind = task.evidence?.recovery?.kind ?? task.evidence?.blockerKind
  return kind === 'dependency-human' || task.evidence?.recovery?.action === 'pause-human'
}

function isExecutionFailureRetryable(task: TaskProgressItemDto): boolean {
  if (task.status !== 'failed') return false
  if (task.executionStatus === 'blocked' && isHumanBlockedTask(task)) return false
  if (task.evidence?.recovery?.action === 'pause-human') return false
  if (isHumanBlockedTask(task)) return false
  if (task.executionStatus === 'failed') return true
  if (task.evidence?.recovery?.action === 'terminal-fail') {
    // Manual continue after auto-retry / generation exhaustion: re-queue from breakpoint.
    const kind = task.evidence?.recovery?.kind ?? task.evidence?.blockerKind
    return kind === 'infra' || kind == null
  }
  const code = readTaskErrorCode(task)
  return code !== null && MANUAL_CONTINUE_ERROR_CODES.has(code)
}

function prepareManualTaskRetry(
  plan: SavedJobPlan,
  taskProgress: TaskProgressDto,
  failedTaskId: string
): { plan: SavedJobPlan; taskProgress: TaskProgressDto } {
  const items = resetTaskItemForManualRetry(taskProgress.tasks, failedTaskId)
  const withCounters = resetTaskRecoveryCounters({ ...taskProgress, tasks: items }, failedTaskId, [
    'infra',
    'prep',
    'repair'
  ])
  return {
    plan,
    taskProgress: {
      ...withCounters,
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

function readGateId(job: ThreadJobDto): string | null {
  const fromParams = job.taskProgress.progressParams?.id
  if (typeof fromParams === 'string' && fromParams.trim()) return fromParams
  const lastErrorDto =
    typeof job.lastError === 'object' && job.lastError
      ? job.lastError
      : coerceTurnErrorField(job.lastError)
  const fromError = lastErrorDto?.params?.taskId
  if (typeof fromError === 'string' && fromError.trim()) return fromError
  return null
}

function resetGateVerificationInProgress(
  taskProgress: TaskProgressDto,
  gateId: string
): TaskProgressDto {
  const isMilestone = /^m\d+$/i.test(gateId)
  const slices = taskProgress.slices?.map((slice) => {
    if (slice.id !== gateId && !(isMilestone && slice.id.startsWith(`${gateId}-`))) {
      return { ...slice }
    }
    return {
      ...slice,
      runtimeStatus: 'ready-for-verification',
      verificationStatus: 'ready-for-verification'
    }
  })
  const milestones = taskProgress.milestones?.map((milestone) => {
    if (milestone.id !== gateId) return { ...milestone }
    return {
      ...milestone,
      verificationStatus: 'ready-for-verification'
    }
  })

  const repairGenerations = { ...(taskProgress.repairGenerations ?? {}) }
  if (isMilestone) {
    delete repairGenerations[repairGenerationKey('milestone', gateId)]
  } else {
    delete repairGenerations[repairGenerationKey('slice', gateId)]
  }

  return {
    ...taskProgress,
    slices,
    milestones,
    repairGenerations,
    phase: 'running',
    status: 'running',
    message: null,
    progressCode: 'execution.resuming',
    progressParams: { id: gateId },
    currentTaskId: null
  }
}

function prepareGateContinueExecution(
  job: ThreadJobDto,
  plan: SavedJobPlan
): { plan: SavedJobPlan; taskProgress: TaskProgressDto } {
  const gateId = readGateId(job)
  if (!gateId) {
    throw createTurnError('task.execution_failed', {
      detail: 'No gate id to continue from verification failure'
    })
  }

  let taskProgress: TaskProgressDto = {
    ...job.taskProgress,
    tasks: job.taskProgress.tasks.map((task) => ({ ...task }))
  }
  taskProgress = resetGateVerificationInProgress(taskProgress, gateId)

  return {
    plan: clonePlan(plan),
    taskProgress
  }
}

export function prepareContinueFailedExecution(
  job: ThreadJobDto,
  plan: SavedJobPlan
): { plan: SavedJobPlan; taskProgress: TaskProgressDto } {
  const state = deriveJobRecoveryState(job)
  if (isGateFailureProgressCode(job.taskProgress.progressCode)) {
    return prepareGateContinueExecution(job, plan)
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
    const { progress } = prepareInterruptedExecutionResume(taskProgress)
    return {
      plan: currentPlan,
      taskProgress: {
        ...progress,
        phase: 'running',
        status: 'running',
        message: null,
        progressCode: 'execution.resuming',
        progressParams: job.taskProgress.progressParams ?? null,
        currentTaskId: null
      }
    }
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
  if (failureKind === 'human_blocked' || isHumanBlockedTask(task)) {
    // Continue means "the external prerequisite has been addressed; retry the
    // same breakpoint". It must not force the user to clear completed work.
    return prepareManualTaskRetry(currentPlan, taskProgress, failedTaskId)
  }

  // Class A: timeout / false-cancel / infra / exhausted auto-retry → re-queue from breakpoint.
  if (isExecutionFailureRetryable(task)) {
    return prepareManualTaskRetry(currentPlan, taskProgress, failedTaskId)
  }

  if (failureKind === 'infra_retryable' || task.executionStatus === 'retry-queued') {
    const looksInfra =
      task.executionStatus === 'retry-queued' ||
      task.evidence?.blockerKind === 'infra' ||
      task.evidence?.recovery?.kind === 'infra'
    if (looksInfra) {
      const items = resetTaskItemForManualRetry(taskProgress.tasks, failedTaskId).map((item) =>
        item.id === failedTaskId
          ? { ...item, status: 'queued' as const, executionStatus: 'retry-queued' }
          : item
      )
      const withCounters = resetTaskRecoveryCounters(
        { ...taskProgress, tasks: items },
        failedTaskId,
        ['infra']
      )
      return {
        plan: currentPlan,
        taskProgress: {
          ...withCounters,
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
  }

  // Class B: structural blocker → inject prep/repair ahead of the blocked task.
  // Reset generation counters so manual continue can re-inject after exhaustion.
  taskProgress = resetTaskRecoveryCounters(taskProgress, failedTaskId, ['infra', 'prep', 'repair'])
  const packet = syntheticPacket(task)

  const recovery = resolveTaskRecoveryAction({
    packet,
    taskId: failedTaskId,
    taskProgress
  })

  if (recovery.action === 'pause-human') {
    throw createTurnError('task.terminal_failure', {
      params: { taskId: failedTaskId },
      detail: recovery.message
    })
  }

  if (recovery.action === 'terminal-fail') {
    // Last resort: still re-queue so Continue is never a dead end for non-human failures.
    return prepareManualTaskRetry(currentPlan, taskProgress, failedTaskId)
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

  return prepareManualTaskRetry(currentPlan, taskProgress, failedTaskId)
}
