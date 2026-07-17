import {
  normalizeTurnError,
  turnErrorFromUnknown,
  isUserTurnCancellation as sharedIsUserTurnCancellation,
  TurnError,
  isTurnError,
  createTurnError
} from '../../shared/turn-errors.ts'
import type { TurnErrorCode, TurnErrorDto } from '../../shared/turn-errors.ts'
import { AppError } from '../error.ts'

export function toTurnErrorDto(error: unknown): TurnErrorDto {
  if (error instanceof AppError) {
    const code = error.data.turnErrorCode
    if (typeof code === 'string') {
      const params = error.data.turnErrorParams
      return createTurnError(code as TurnErrorCode, {
        params:
          typeof params === 'object' && params
            ? (params as Record<string, string | number | boolean>)
            : undefined,
        detail: error.message
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
  if (dto.detail && dto.detail.trim() && dto.detail !== dto.message) {
    return `${dto.message}: ${dto.detail}`
  }
  return dto.message
}

export { isUserTurnCancellation } from '../../shared/turn-errors.ts'

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
