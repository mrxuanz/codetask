import type { TurnErrorDto } from './types.ts'
import { fromTurnErrorDto, toTurnErrorDto, type StoredTurnErrorPayload } from './types.ts'
import { TURN_ERROR_SCHEMA_VERSION } from './codes.ts'

const STORAGE_PREFIX = 'codetask-error:v1:'

function isStoredPayload(value: unknown): value is StoredTurnErrorPayload {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.v === TURN_ERROR_SCHEMA_VERSION &&
    typeof record.code === 'string' &&
    typeof record.message === 'string'
  )
}

export function parseStoredTurnError(raw: string | null | undefined): TurnErrorDto | null {
  if (!raw?.trim()) return null
  const trimmed = raw.trim()

  if (trimmed.startsWith(STORAGE_PREFIX)) {
    try {
      const payload = JSON.parse(trimmed.slice(STORAGE_PREFIX.length)) as unknown
      if (isStoredPayload(payload)) return toTurnErrorDto(payload)
    } catch {
      // ignore
    }
  }

  if (trimmed.startsWith('{')) {
    try {
      const payload = JSON.parse(trimmed) as unknown
      if (isStoredPayload(payload)) return toTurnErrorDto(payload)
    } catch {
      // ignore
    }
  }

  return null
}

export function serializeStoredTurnError(dto: TurnErrorDto): string {
  const payload = fromTurnErrorDto(dto)
  return `${STORAGE_PREFIX}${JSON.stringify(payload)}`
}

export function coerceTurnErrorField(
  value: TurnErrorDto | string | null | undefined
): TurnErrorDto | null {
  if (!value) return null
  if (typeof value === 'object') return value
  return parseStoredTurnError(value)
}

export function turnErrorDisplayMessage(dto: TurnErrorDto | null | undefined): string | null {
  return dto?.message?.trim() || null
}
