import { normalizeTurnError } from '../../../shared/turn-errors.ts'

export function classifyCursorAcpErrorLite(error: unknown): string {
  return normalizeTurnError(error).message
}
