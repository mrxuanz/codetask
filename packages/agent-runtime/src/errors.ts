import {
  normalizeTurnError,
  turnErrorFromUnknown,
  isUserTurnCancellation as sharedIsUserTurnCancellation,
  TurnError,
  isTurnError,
  createTurnError
} from '@codetask/contracts/turn-errors'
import type { TurnErrorCode, TurnErrorDto } from '@codetask/contracts/turn-errors'

export function toTurnErrorDto(error: unknown): TurnErrorDto {
  // AppError lives in the host; inspect duck-typed turnErrorCode when present.
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: Record<string, unknown> }).data
    const code = data?.turnErrorCode
    if (typeof code === 'string') {
      const params = data?.turnErrorParams
      return createTurnError(code as TurnErrorCode, {
        params:
          typeof params === 'object' && params
            ? (params as Record<string, string | number | boolean>)
            : undefined,
        detail: error instanceof Error ? error.message : String(error)
      }).toDto()
    }
  }
  return turnErrorFromUnknown(error)
}

export function throwSdkTurnError(error: unknown): never {
  if (isTurnError(error)) throw error
  const dto = normalizeTurnError(error)
  throw new TurnError(dto.code, {
    params: dto.params,
    detail: dto.detail ?? undefined,
    message: dto.message
  })
}

export function formatSdkTurnError(error: unknown): string {
  const dto = normalizeTurnError(error)
  return dto.message
}

export function isUserTurnCancellation(error: unknown): boolean {
  return sharedIsUserTurnCancellation(error)
}

export function isTurnCancelled(error: unknown): boolean {
  return sharedIsUserTurnCancellation(error)
}

export function turnErrorChunk(error: unknown): {
  type: 'error'
  message: string
  error: TurnErrorDto
} {
  const dto = normalizeTurnError(error)
  return { type: 'error', message: dto.message, error: dto }
}

export { createTurnError, isTurnError, TurnError, normalizeTurnError, turnErrorFromUnknown }
export type { TurnErrorCode, TurnErrorDto }
