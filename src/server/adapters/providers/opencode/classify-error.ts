import type { ProviderError } from '../events'
import { classifyUnknownError } from '../classify-error'

export function classifyOpenCodeError(error: unknown): ProviderError {
  return classifyUnknownError(error, 'opencode')
}
