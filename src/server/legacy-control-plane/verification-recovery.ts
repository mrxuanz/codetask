import { turnRetryDelayMs } from '../agent-runtime/retry'
import {
  createTurnError,
  isInfraTurnError,
  isRetryableTurnError,
  isVerifierToolMissMessage,
  resolveTurnErrorDto
} from '../../shared/turn-errors.ts'
import type { TurnErrorDto } from '../../shared/turn-errors.ts'
import type { TaskProgressDto } from './types'
import { verifierInfraRetryGenerationKey } from './repair-tasks'
import { MAX_VERIFIER_INFRA_RETRIES, VERIFIER_VERDICT_GRACE_MS } from './recovery-limits'

export { VERIFIER_VERDICT_GRACE_MS, MAX_VERIFIER_INFRA_RETRIES }
export { isVerifierToolMissMessage } from '../../shared/turn-errors.ts'

export function verifierInfraAttempt(
  progress: TaskProgressDto,
  scope: 'slice' | 'milestone',
  id: string
): number {
  return progress.repairGenerations?.[verifierInfraRetryGenerationKey(scope, id)] ?? 0
}

export function withVerifierInfraAttempt(
  progress: TaskProgressDto,
  scope: 'slice' | 'milestone',
  id: string,
  attempt: number
): TaskProgressDto {
  const key = verifierInfraRetryGenerationKey(scope, id)
  return {
    ...progress,
    repairGenerations: {
      ...(progress.repairGenerations ?? {}),
      [key]: attempt
    }
  }
}

export type VerifierInfraRecovery =
  | {
      action: 'infra-retry'
      message: string
      error: TurnErrorDto
      attempt: number
      maxAttempts: number
      delayMs: number
    }
  | { action: 'terminal-fail'; message: string; error: TurnErrorDto }

function terminalVerifierFailure(
  _scope: 'slice' | 'milestone',
  id: string,
  turnError: TurnErrorDto,
  detail?: string
): VerifierInfraRecovery {
  const error = createTurnError('task.terminal_failure', {
    params: { taskId: id },
    detail: detail ?? turnError.detail ?? turnError.message
  }).toDto()
  return { action: 'terminal-fail', message: error.message, error }
}

function exhaustedVerifierRetry(
  _scope: 'slice' | 'milestone',
  id: string,
  turnError: TurnErrorDto
): VerifierInfraRecovery {
  const error = createTurnError('task.infra_retry_exhausted', {
    params: { taskId: id, maxAttempts: MAX_VERIFIER_INFRA_RETRIES },
    detail: turnError.detail ?? turnError.message
  }).toDto()
  return { action: 'terminal-fail', message: error.message, error }
}

export function resolveVerifierInfraRecovery(input: {
  scope: 'slice' | 'milestone'
  id: string
  taskProgress: TaskProgressDto
  message: string
  error?: unknown
}): VerifierInfraRecovery {
  const turnError =
    input.error !== undefined
      ? resolveTurnErrorDto(input.error)
      : resolveTurnErrorDto(new Error(input.message))

  const verifierMiss =
    turnError.code === 'task.verifier_evidence_timeout' ||
    (input.error === undefined && isVerifierToolMissMessage(input.message))
  const infraEligible =
    verifierMiss ||
    input.error === undefined ||
    isRetryableTurnError(input.error) ||
    isInfraTurnError(input.error)

  if (input.error !== undefined && !infraEligible) {
    return terminalVerifierFailure(input.scope, input.id, turnError)
  }

  if (!infraEligible) {
    return terminalVerifierFailure(input.scope, input.id, turnError)
  }

  const nextAttempt = verifierInfraAttempt(input.taskProgress, input.scope, input.id) + 1
  if (nextAttempt > MAX_VERIFIER_INFRA_RETRIES) {
    return exhaustedVerifierRetry(input.scope, input.id, turnError)
  }

  const error = createTurnError('task.infra_retry', {
    params: { taskId: input.id, attempt: nextAttempt, maxAttempts: MAX_VERIFIER_INFRA_RETRIES },
    detail: turnError.detail ?? turnError.message
  }).toDto()

  return {
    action: 'infra-retry',
    message: error.message,
    error,
    attempt: nextAttempt,
    maxAttempts: MAX_VERIFIER_INFRA_RETRIES,
    delayMs: turnRetryDelayMs(nextAttempt, input.error ?? turnError)
  }
}

export function resetVerifierInfraCounter(
  progress: TaskProgressDto,
  scope: 'slice' | 'milestone',
  id: string
): TaskProgressDto {
  const key = verifierInfraRetryGenerationKey(scope, id)
  const next = { ...(progress.repairGenerations ?? {}) }
  delete next[key]
  return { ...progress, repairGenerations: next }
}
