import type { ProviderError } from '../events'
import { classifyUnknownError } from '../classify-error'

/** Fake-specific error classification helper. */
export function classifyFakeError(error: unknown): ProviderError {
  return classifyUnknownError(error, 'fake')
}
