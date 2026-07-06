import type { TurnErrorDto } from '../../shared/turn-errors.ts'
import {
  normalizeTurnError,
  normalizeTurnErrorFromMessage,
  parseStoredTurnError,
  serializeStoredTurnError,
  turnErrorDisplayMessage
} from '../../shared/turn-errors.ts'

export function hydrateTurnErrorField(raw: string | null | undefined): TurnErrorDto | null {
  return parseStoredTurnError(raw)
}

export function persistTurnError(error: unknown): string {
  return serializeStoredTurnError(normalizeTurnError(error))
}

export function persistTurnErrorDto(dto: TurnErrorDto): string {
  return serializeStoredTurnError(dto)
}

export function coercePersistedTurnError(
  value: TurnErrorDto | string | null | undefined
): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return serializeStoredTurnError(value)
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('codetask-error:v1:')) return trimmed
  if (trimmed.startsWith('{') && parseStoredTurnError(trimmed)) return trimmed
  return serializeStoredTurnError(normalizeTurnErrorFromMessage(trimmed))
}

export function taskErrorFields(
  error: unknown
): Pick<{ error: TurnErrorDto; errorMessage: string | null }, 'error' | 'errorMessage'> {
  const dto = normalizeTurnError(error)
  return {
    error: dto,
    errorMessage: turnErrorDisplayMessage(dto)
  }
}

export function taskErrorFieldsFromDto(
  dto: TurnErrorDto
): Pick<{ error: TurnErrorDto; errorMessage: string | null }, 'error' | 'errorMessage'> {
  return {
    error: dto,
    errorMessage: turnErrorDisplayMessage(dto)
  }
}

export function turnErrorMessage(error: unknown): string {
  return normalizeTurnError(error).message
}

export function turnErrorMessageFromDto(dto: TurnErrorDto): string {
  return dto.message
}
