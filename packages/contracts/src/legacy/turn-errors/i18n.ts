import type { TurnErrorCode } from './codes.ts'
import { TURN_ERROR_DEFAULT_MESSAGES } from './codes.ts'

export function buildTurnErrorI18nTree(
  messages: Record<TurnErrorCode, string>
): Record<string, unknown> {
  const tree: Record<string, unknown> = {}
  for (const [code, message] of Object.entries(messages) as Array<[TurnErrorCode, string]>) {
    const parts = code.split('.')
    let node = tree
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!
      if (!node[part] || typeof node[part] !== 'object') {
        node[part] = {}
      }
      node = node[part] as Record<string, unknown>
    }
    node[parts[parts.length - 1]!] = message
  }
  return tree
}

export const turnErrorsEn = buildTurnErrorI18nTree(TURN_ERROR_DEFAULT_MESSAGES)

export function turnErrorI18nKey(code: TurnErrorCode): string {
  return `turnErrors.${code}`
}
