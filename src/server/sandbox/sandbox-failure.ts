import type { PlanProgressDto, TaskProgressDto } from '../jobs/types'
import { ProviderAuthError } from './provider-auth'
import { SandboxError } from './types'
import { createTurnError, normalizeTurnError, type TurnErrorDto } from '../../shared/turn-errors.ts'
import { toTurnErrorDto } from '../agent-runtime/errors'
import { persistTurnErrorDto } from '../turn-errors/store'

export interface SandboxFailurePlan {
  planProgress: PlanProgressDto
  lastError: TurnErrorDto
}

export interface SandboxFailureTask {
  taskProgress: Partial<TaskProgressDto>
  lastError: TurnErrorDto
  failed: boolean
}

function dto(error: unknown): TurnErrorDto {
  return toTurnErrorDto(error)
}

export function planFailureFromSandboxError(error: unknown): SandboxFailurePlan {
  const fallback = dto(error)

  if (
    error instanceof ProviderAuthError ||
    (error instanceof SandboxError && error.code === 'provider.auth.missing')
  ) {
    const auth = createTurnError('provider.auth.missing', { detail: fallback.detail ?? undefined })
    return {
      lastError: auth.toDto(),
      planProgress: {
        phase: 'needs_auth',
        status: 'failed',
        contextsRegistered: 0,
        contextsTotal: 0,
        message: null,
        progressCode: 'plan.needs_auth',
        progressParams: null
      }
    }
  }

  if (error instanceof SandboxError) {
    switch (error.code) {
      case 'sandbox.supervisor.cleanup_failed':
      case 'sandbox.supervisor.crashed': {
        const planError = createTurnError('plan.sandbox_cleanup_failed', {
          detail: fallback.detail ?? undefined
        })
        return {
          lastError: planError.toDto(),
          planProgress: {
            phase: 'cleanup_failed',
            status: 'failed',
            contextsRegistered: 0,
            contextsTotal: 0,
            message: null,
            progressCode: 'plan.cleanup_failed',
            progressParams: null
          }
        }
      }
      case 'sandbox.turn.timed_out': {
        const planError = createTurnError('plan.sandbox_timeout', {
          detail: fallback.detail ?? undefined
        })
        return {
          lastError: planError.toDto(),
          planProgress: {
            phase: 'failed',
            status: 'failed',
            contextsRegistered: 0,
            contextsTotal: 0,
            message: null,
            progressCode: 'plan.planning_failed',
            progressParams: null
          }
        }
      }
      case 'sandbox.turn.cancelled': {
        const planError = createTurnError('plan.cancelled')
        return {
          lastError: planError.toDto(),
          planProgress: {
            phase: 'failed',
            status: 'failed',
            contextsRegistered: 0,
            contextsTotal: 0,
            message: null,
            progressCode: 'plan.planning_failed',
            progressParams: null
          }
        }
      }
      default:
        break
    }
  }

  return {
    lastError: fallback,
    planProgress: {
      phase: 'failed',
      status: 'failed',
      contextsRegistered: 0,
      contextsTotal: 0,
      message: null,
      progressCode: 'plan.planning_failed',
      progressParams: null
    }
  }
}

export function taskFailureFromSandboxError(
  error: unknown,
  base: Pick<
    TaskProgressDto,
    'phase' | 'status' | 'currentIndex' | 'total' | 'currentTaskId' | 'tasks'
  >
): SandboxFailureTask {
  const fallback = dto(error)

  if (fallback.code === 'job.paused') {
    return { failed: false, lastError: fallback, taskProgress: {} }
  }

  if (error instanceof SandboxError) {
    switch (error.code) {
      case 'sandbox.supervisor.cleanup_failed':
      case 'sandbox.supervisor.crashed': {
        const taskError = createTurnError('plan.sandbox_cleanup_failed', {
          detail: fallback.detail ?? undefined
        })
        return {
          failed: true,
          lastError: taskError.toDto(),
          taskProgress: {
            ...base,
            phase: 'failed',
            status: 'failed',
            message: null,
            progressCode: 'execution.failed',
            progressParams: null
          }
        }
      }
      case 'sandbox.turn.timed_out': {
        const taskError = createTurnError('sandbox.turn.timed_out', {
          detail: fallback.detail ?? undefined
        })
        return {
          failed: true,
          lastError: taskError.toDto(),
          taskProgress: {
            ...base,
            phase: 'failed',
            status: 'failed',
            message: null,
            progressCode: 'execution.failed',
            progressParams: null
          }
        }
      }
      default:
        break
    }
  }

  return {
    failed: true,
    lastError: fallback,
    taskProgress: {
      ...base,
      phase: 'failed',
      status: 'failed',
      message: null,
      progressCode: 'execution.failed',
      progressParams: null
    }
  }
}

export function isSandboxCleanupFailure(error: unknown): boolean {
  return (
    error instanceof SandboxError &&
    (error.code === 'sandbox.supervisor.cleanup_failed' ||
      error.code === 'sandbox.supervisor.crashed')
  )
}

export function sandboxFailureMessage(error: unknown): string {
  return normalizeTurnError(error).message
}

export function sandboxFailureStored(error: unknown): string {
  return persistTurnErrorDto(normalizeTurnError(error))
}
