import { normalizeTurnError } from '@shared/turn-errors/index.ts'

export function classifyCursorAcpErrorLite(error: unknown): string {
  return normalizeTurnError(error).message
}
