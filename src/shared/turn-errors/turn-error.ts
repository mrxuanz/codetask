import type { TurnErrorCode, TurnErrorParams } from './codes.ts'
import { TURN_ERROR_DEFAULT_MESSAGES } from './codes.ts'
import type { TurnErrorDto } from './types.ts'

function interpolate(template: string, params?: TurnErrorParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key]
    return value === undefined ? `{${key}}` : String(value)
  })
}

export function formatTurnErrorMessage(code: TurnErrorCode, params?: TurnErrorParams): string {
  return interpolate(TURN_ERROR_DEFAULT_MESSAGES[code], params)
}

export class TurnError extends Error {
  readonly code: TurnErrorCode
  readonly params?: TurnErrorParams
  readonly detail?: string

  constructor(
    code: TurnErrorCode,
    options?: { params?: TurnErrorParams; detail?: string; message?: string }
  ) {
    const message = options?.message?.trim() || formatTurnErrorMessage(code, options?.params)
    super(message)
    this.name = 'TurnError'
    this.code = code
    this.params = options?.params
    this.detail = options?.detail
  }

  toDto(): TurnErrorDto {
    return {
      code: this.code,
      message: this.message,
      params: this.params,
      detail: this.detail ?? null
    }
  }
}

export function createTurnError(
  code: TurnErrorCode,
  options?: { params?: TurnErrorParams; detail?: string; message?: string }
): TurnError {
  return new TurnError(code, options)
}

export function isTurnError(error: unknown): error is TurnError {
  return error instanceof TurnError
}

export const TURN_CANCELLED = createTurnError('turn.cancelled')
export const JOB_PAUSED = createTurnError('job.paused')
export const JOB_CANCELLED = createTurnError('job.cancelled')
