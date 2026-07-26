import type { ProviderError } from '../events'
import { classifyUnknownError } from '../classify-error'

export function classifyCursorError(error: unknown): ProviderError {
  return classifyUnknownError(error, 'cursor')
}
