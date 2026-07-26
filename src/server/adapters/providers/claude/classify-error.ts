import type { ProviderError } from '../events'
import { classifyUnknownError } from '../classify-error'

export function classifyClaudeError(error: unknown): ProviderError {
  return classifyUnknownError(error, 'claude')
}
