import type { ProviderError } from '../events'
import { classifyUnknownError } from '../classify-error'

export function classifyCodexError(error: unknown): ProviderError {
  return classifyUnknownError(error, 'codex')
}
