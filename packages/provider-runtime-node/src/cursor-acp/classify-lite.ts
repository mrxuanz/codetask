import { normalizeTurnError } from '@codetask/contracts/turn-errors'

export function classifyCursorAcpErrorLite(error: unknown): string {
  return normalizeTurnError(error).message
}
