import type { Composer } from 'vue-i18n'
import type { TurnErrorCode, TurnErrorDto } from '@shared/turn-errors'
import {
  coerceTurnErrorField,
  isTurnErrorCode,
  parseStoredTurnError,
  turnErrorI18nKey
} from '@shared/turn-errors'

function interpolate(template: string, params?: TurnErrorDto['params']): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key]
    return value === undefined ? `{${key}}` : String(value)
  })
}

function coerceLooseTurnError(input: unknown): TurnErrorDto | null {
  if (!input) return null
  if (typeof input === 'string') {
    return parseStoredTurnError(input) ?? coerceTurnErrorField(input)
  }
  if (typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  if (typeof record.message !== 'string') return null
  const code =
    typeof record.code === 'string' && isTurnErrorCode(record.code) ? record.code : 'turn.unknown'
  return {
    code,
    message: record.message,
    detail: typeof record.detail === 'string' ? record.detail : record.detail === null ? null : undefined,
    params:
      record.params && typeof record.params === 'object' && !Array.isArray(record.params)
        ? (record.params as TurnErrorDto['params'])
        : undefined
  }
}

/** Accepts shared TurnErrorDto, contract `{ code: string }` errors, or unknown job.lastError. */
export function formatTurnError(
  input: TurnErrorDto | string | null | undefined | unknown,
  t: Composer['t']
): string | null {
  if (!input) return null

  const dto = coerceLooseTurnError(input)

  if (!dto) return typeof input === 'string' ? input : null

  const key = turnErrorI18nKey(dto.code)
  const translated = t(key, dto.params ?? {})
  if (translated !== key) {
    return interpolate(translated, dto.params)
  }

  return interpolate(dto.message, dto.params)
}

export function formatTurnErrorCode(
  code: TurnErrorCode,
  t: Composer['t'],
  params?: TurnErrorDto['params']
): string {
  const key = turnErrorI18nKey(code)
  const translated = t(key, params ?? {})
  if (translated !== key) return interpolate(translated, params)
  return interpolate(key, params)
}
