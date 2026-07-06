import type { Composer } from 'vue-i18n'
import type { TurnErrorCode, TurnErrorDto } from '@shared/turn-errors'
import { coerceTurnErrorField, parseStoredTurnError, turnErrorI18nKey } from '@shared/turn-errors'

function interpolate(template: string, params?: TurnErrorDto['params']): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key]
    return value === undefined ? `{${key}}` : String(value)
  })
}

export function formatTurnError(
  input: TurnErrorDto | string | null | undefined,
  t: Composer['t']
): string | null {
  if (!input) return null

  const dto =
    typeof input === 'string' ? (parseStoredTurnError(input) ?? coerceTurnErrorField(input)) : input

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
