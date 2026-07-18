import { turnRetryDelayMs } from '../../agent-runtime/retry'
import { createTurnError, resolveTurnErrorDto } from '../../../shared/turn-errors.ts'
import {
  isInfraTurnError,
  isRetryableTurnError,
  isTaskEvidenceMissError
} from '../../../shared/turn-errors.ts'
import { taskErrorFieldsFromDto } from '../../turn-errors/store'
import type { TurnErrorDto } from '../../../shared/turn-errors.ts'
import type { TaskProgressDto, TaskProgressItemDto } from '../types'
import type { SavedJobPlan } from '../../planner/plan-types'
import {
  injectTaskDependencyPrepTask,
  injectTaskImplementationRepairTask,
  taskInfraRetryGenerationKey,
  taskPrepGenerationKey,
  taskRepairGenerationKey
} from '../repair-tasks'
import {
  MAX_INFRA_RETRIES,
  MAX_TASK_PREP_GENERATIONS,
  MAX_TASK_REPAIR_GENERATIONS
} from '../recovery-limits'
import { classifyTaskOutcome } from './classify'
import type { TaskBlockerClassification, TaskEvidencePacket, TaskRecoveryAction } from './types'

export {
  MAX_INFRA_RETRIES as MAX_TASK_INFRA_RETRIES,
  MAX_TASK_PREP_GENERATIONS,
  MAX_TASK_REPAIR_GENERATIONS
}

export { isTaskEvidenceMissError as isTaskEvidenceMissMessage } from '../../../shared/turn-errors.ts'

function taskInfraAttempt(progress: TaskProgressDto, taskId: string): number {
  return progress.repairGenerations?.[taskInfraRetryGenerationKey(taskId)] ?? 0
}

function taskPrepAttempt(progress: TaskProgressDto, taskId: string): number {
  return progress.repairGenerations?.[taskPrepGenerationKey(taskId)] ?? 0
}

function taskRepairAttempt(progress: TaskProgressDto, taskId: string): number {
  return progress.repairGenerations?.[taskRepairGenerationKey(taskId)] ?? 0
}

function withTaskRecoveryGeneration(
  progress: TaskProgressDto,
  key: string,
  generation: number
): TaskProgressDto {
  return {
    ...progress,
    repairGenerations: {
      ...(progress.repairGenerations ?? {}),
      [key]: generation
    }
  }
}

function enrichEvidence(
  packet: TaskEvidencePacket,
  classification: TaskBlockerClassification,
  recovery: NonNullable<TaskEvidencePacket['recovery']>
): TaskEvidencePacket {
  return {
    ...packet,
    blockerKind: classification.kind,
    recovery
  }
}

function terminalFailure(taskId: string, detail: string): TurnErrorDto {
  return createTurnError('task.terminal_failure', {
    params: { taskId },
    detail
  }).toDto()
}

export function applyTaskInfraRetryItem(
  items: TaskProgressItemDto[],
  taskId: string,
  packet: TaskEvidencePacket,
  classification: TaskBlockerClassification,
  attempt: number,
  maxAttempts: number
): TaskProgressItemDto[] {
  const error = createTurnError('task.infra_retry', {
    params: { taskId, attempt, maxAttempts },
    detail: classification.reasons[0] ?? packet.summary
  }).toDto()
  const fields = taskErrorFieldsFromDto(error)
  return items.map((item) =>
    item.id === taskId
      ? {
          ...item,
          status: 'queued',
          executionStatus: 'retry-queued',
          evidenceStatus: null,
          evidence: enrichEvidence(packet, classification, {
            kind: classification.kind,
            source: classification.source,
            confidence: classification.confidence,
            reasons: classification.reasons,
            attempt,
            maxAttempts,
            action: 'infra-retry'
          }),
          ...fields
        }
      : item
  )
}

export function applyTaskPrepRecoveryItem(
  items: TaskProgressItemDto[],
  taskId: string,
  packet: TaskEvidencePacket,
  classification: TaskBlockerClassification,
  attempt: number,
  maxAttempts: number
): TaskProgressItemDto[] {
  const error = createTurnError('task.terminal_failure', {
    params: { taskId },
    detail: packet.blockers?.[0] ?? packet.summary
  }).toDto()
  const fields = taskErrorFieldsFromDto(error)
  return items.map((item) =>
    item.id === taskId
      ? {
          ...item,
          status: 'queued',
          executionStatus: 'waiting-on-dependency',
          evidenceStatus: null,
          evidence: enrichEvidence(packet, classification, {
            kind: classification.kind,
            source: classification.source,
            confidence: classification.confidence,
            reasons: classification.reasons,
            attempt,
            maxAttempts,
            action: 'inject-prep'
          }),
          ...fields
        }
      : item
  )
}

export function applyTaskRepairRecoveryItem(
  items: TaskProgressItemDto[],
  taskId: string,
  packet: TaskEvidencePacket,
  classification: TaskBlockerClassification,
  attempt: number,
  maxAttempts: number
): TaskProgressItemDto[] {
  const error = createTurnError('task.terminal_failure', {
    params: { taskId },
    detail: packet.blockers?.[0] ?? packet.summary
  }).toDto()
  const fields = taskErrorFieldsFromDto(error)
  return items.map((item) =>
    item.id === taskId
      ? {
          ...item,
          status: 'queued',
          executionStatus: 'waiting-on-repair',
          evidenceStatus: null,
          evidence: enrichEvidence(packet, classification, {
            kind: classification.kind,
            source: classification.source,
            confidence: classification.confidence,
            reasons: classification.reasons,
            attempt,
            maxAttempts,
            action: 'inject-repair'
          }),
          ...fields
        }
      : item
  )
}

export function applyTaskTerminalFailureItem(
  items: TaskProgressItemDto[],
  taskId: string,
  packet: TaskEvidencePacket,
  classification: TaskBlockerClassification,
  error: TurnErrorDto
): TaskProgressItemDto[] {
  const fields = taskErrorFieldsFromDto(error)
  return items.map((item) =>
    item.id === taskId
      ? {
          ...item,
          status: 'failed',
          executionStatus: packet.status,
          evidenceStatus: 'basic-facts-ok',
          evidence: enrichEvidence(packet, classification, {
            kind: classification.kind,
            source: classification.source,
            confidence: classification.confidence,
            reasons: classification.reasons,
            action: 'terminal-fail'
          }),
          ...fields
        }
      : item
  )
}

function resolveInfraRetry(input: {
  taskId: string
  taskProgress: TaskProgressDto
  error: TurnErrorDto
  classification: TaskBlockerClassification
}): TaskRecoveryAction {
  const nextAttempt = taskInfraAttempt(input.taskProgress, input.taskId) + 1
  if (nextAttempt > MAX_INFRA_RETRIES) {
    const exhausted = createTurnError('task.infra_retry_exhausted', {
      params: { taskId: input.taskId, maxAttempts: MAX_INFRA_RETRIES },
      detail: input.error.detail ?? input.error.message
    }).toDto()
    return {
      action: 'terminal-fail',
      message: exhausted.message,
      error: exhausted,
      classification: input.classification
    }
  }
  const retry = createTurnError('task.infra_retry', {
    params: {
      taskId: input.taskId,
      attempt: nextAttempt,
      maxAttempts: MAX_INFRA_RETRIES
    },
    detail: input.error.detail ?? input.error.message
  }).toDto()
  return {
    action: 'infra-retry',
    message: retry.message,
    error: retry,
    attempt: nextAttempt,
    maxAttempts: MAX_INFRA_RETRIES,
    delayMs: turnRetryDelayMs(nextAttempt, input.error),
    classification: input.classification
  }
}

export function resolveTaskRecoveryAction(input: {
  packet: TaskEvidencePacket
  taskId: string
  taskProgress: TaskProgressDto
}): TaskRecoveryAction {
  const classification = classifyTaskOutcome(input.packet)
  const detail = input.packet.blockers?.join('; ') ?? input.packet.summary

  if (classification.kind === 'infra') {
    return resolveInfraRetry({
      taskId: input.taskId,
      taskProgress: input.taskProgress,
      error: resolveTurnErrorDto(new Error(detail)),
      classification
    })
  }

  if (classification.kind === 'dependency-prep') {
    const nextAttempt = taskPrepAttempt(input.taskProgress, input.taskId) + 1
    if (nextAttempt > MAX_TASK_PREP_GENERATIONS) {
      const error = terminalFailure(
        input.taskId,
        `Dependency prep generations exhausted (${MAX_TASK_PREP_GENERATIONS}): ${detail}`
      )
      return { action: 'terminal-fail', message: error.message, error, classification }
    }
    const error = createTurnError('task.terminal_failure', {
      params: { taskId: input.taskId },
      detail
    }).toDto()
    return {
      action: 'inject-prep',
      message: error.message,
      error,
      attempt: nextAttempt,
      maxAttempts: MAX_TASK_PREP_GENERATIONS,
      newTaskIds: [],
      classification
    }
  }

  if (classification.kind === 'implementation') {
    const nextAttempt = taskRepairAttempt(input.taskProgress, input.taskId) + 1
    if (nextAttempt > MAX_TASK_REPAIR_GENERATIONS) {
      const error = terminalFailure(
        input.taskId,
        `Implementation repair generations exhausted (${MAX_TASK_REPAIR_GENERATIONS}): ${detail}`
      )
      return { action: 'terminal-fail', message: error.message, error, classification }
    }
    const error = createTurnError('task.terminal_failure', {
      params: { taskId: input.taskId },
      detail
    }).toDto()
    return {
      action: 'inject-repair',
      message: error.message,
      error,
      attempt: nextAttempt,
      maxAttempts: MAX_TASK_REPAIR_GENERATIONS,
      newTaskIds: [],
      classification
    }
  }

  if (classification.kind === 'dependency-human') {
    const error = createTurnError('task.terminal_failure', {
      params: { taskId: input.taskId },
      detail
    }).toDto()
    return { action: 'pause-human', message: error.message, error, classification }
  }

  const error = terminalFailure(input.taskId, `Task reported ${input.packet.status}: ${detail}`)
  return { action: 'terminal-fail', message: error.message, error, classification }
}

export function injectPrepTasksForRecovery(input: {
  plan: SavedJobPlan
  blockedTaskId: string
  packet: TaskEvidencePacket
  attempt: number
}): string[] {
  const injection = injectTaskDependencyPrepTask({
    plan: input.plan,
    blockedTaskId: input.blockedTaskId,
    summary: input.packet.summary,
    blockers: input.packet.blockers ?? [input.packet.summary],
    generation: input.attempt
  })
  return injection.newTaskIds
}

export function injectRepairTasksForRecovery(input: {
  plan: SavedJobPlan
  blockedTaskId: string
  packet: TaskEvidencePacket
  attempt: number
}): string[] {
  const injection = injectTaskImplementationRepairTask({
    plan: input.plan,
    blockedTaskId: input.blockedTaskId,
    summary: input.packet.summary,
    blockers: input.packet.blockers ?? [input.packet.summary],
    generation: input.attempt
  })
  return injection.newTaskIds
}

export function applyTaskRecoveryGenerationForTask(
  taskProgress: TaskProgressDto,
  taskId: string,
  recovery: TaskRecoveryAction
): TaskProgressDto {
  if (recovery.action === 'infra-retry') {
    return withTaskRecoveryGeneration(
      taskProgress,
      taskInfraRetryGenerationKey(taskId),
      recovery.attempt
    )
  }
  if (recovery.action === 'inject-prep') {
    return withTaskRecoveryGeneration(taskProgress, taskPrepGenerationKey(taskId), recovery.attempt)
  }
  if (recovery.action === 'inject-repair') {
    return withTaskRecoveryGeneration(
      taskProgress,
      taskRepairGenerationKey(taskId),
      recovery.attempt
    )
  }
  return taskProgress
}

export function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const EVIDENCE_MISS_INFRA_CLASSIFICATION: TaskBlockerClassification = {
  kind: 'infra',
  source: 'classifier',
  confidence: 'high',
  reasons: ['task-worker turn ended without report_task_result']
}

function syntheticInfraPacket(taskId: string, detail: string): TaskEvidencePacket {
  return {
    status: 'blocked',
    summary: detail,
    changedFiles: [],
    evidence: [detail],
    validation: { ran: false, outcome: 'skipped' },
    blockers: [`${taskId}: ${detail}`],
    blockerKind: 'infra'
  }
}

export function resolveTaskInfraRecovery(input: {
  taskId: string
  taskProgress: TaskProgressDto
  message: string
  error?: unknown
}): TaskRecoveryAction {
  const turnError =
    input.error !== undefined
      ? resolveTurnErrorDto(input.error)
      : resolveTurnErrorDto(new Error(input.message))

  if (
    input.error !== undefined &&
    !isRetryableTurnError(input.error) &&
    !isTaskEvidenceMissError(input.error) &&
    !isInfraTurnError(input.error)
  ) {
    const terminal = terminalFailure(input.taskId, turnError.message)
    return {
      action: 'terminal-fail',
      message: terminal.message,
      error: terminal,
      classification: EVIDENCE_MISS_INFRA_CLASSIFICATION
    }
  }

  return resolveInfraRetry({
    taskId: input.taskId,
    taskProgress: input.taskProgress,
    error: turnError,
    classification: EVIDENCE_MISS_INFRA_CLASSIFICATION
  })
}

export function resolveEvidenceMissRecovery(input: {
  taskId: string
  taskProgress: TaskProgressDto
  message: string
}): TaskRecoveryAction {
  return resolveTaskInfraRecovery(input)
}

export function applyEvidenceMissInfraRetryItem(
  items: TaskProgressItemDto[],
  taskId: string,
  message: string,
  classification: TaskBlockerClassification,
  attempt: number,
  maxAttempts: number
): TaskProgressItemDto[] {
  const packet = syntheticInfraPacket(taskId, message)
  return applyTaskInfraRetryItem(items, taskId, packet, classification, attempt, maxAttempts)
}

export function resetTaskRecoveryCounters(
  progress: TaskProgressDto,
  taskId: string,
  scopes: Array<'infra' | 'prep' | 'repair'>
): TaskProgressDto {
  const next = { ...(progress.repairGenerations ?? {}) }
  if (scopes.includes('infra')) delete next[taskInfraRetryGenerationKey(taskId)]
  if (scopes.includes('prep')) delete next[taskPrepGenerationKey(taskId)]
  if (scopes.includes('repair')) delete next[taskRepairGenerationKey(taskId)]
  return { ...progress, repairGenerations: next }
}

export function resetTaskItemForManualRetry(
  items: TaskProgressItemDto[],
  taskId: string
): TaskProgressItemDto[] {
  return items.map((item) =>
    item.id === taskId
      ? {
          ...item,
          status: 'queued',
          executionStatus: 'queued',
          evidenceStatus: null,
          evidence: null,
          error: null,
          errorMessage: null
        }
      : item
  )
}
