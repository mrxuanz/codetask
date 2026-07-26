import type { ProviderError } from './events'
import type { ProviderAdapterCode } from './types'

export function classifyUnknownError(
  error: unknown,
  provider: ProviderAdapterCode
): ProviderError {
  if (isProviderErrorShape(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      category: error.category
    }
  }

  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  if (isAbortLike(error) || lower.includes('abort') || lower.includes('cancel')) {
    return {
      code: `${provider}.cancelled`,
      message,
      retryable: false,
      category: 'cancelled'
    }
  }

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return {
      code: `${provider}.timeout`,
      message,
      retryable: true,
      category: 'timeout'
    }
  }

  if (
    lower.includes('auth') ||
    lower.includes('unauthorized') ||
    lower.includes('credential') ||
    lower.includes('api key')
  ) {
    return {
      code: `${provider}.auth`,
      message,
      retryable: false,
      category: 'auth'
    }
  }

  if (
    lower.includes('not found') ||
    lower.includes('not installed') ||
    lower.includes('unavailable')
  ) {
    return {
      code: `${provider}.unavailable`,
      message,
      retryable: false,
      category: 'availability'
    }
  }

  return {
    code: `${provider}.unknown`,
    message,
    retryable: false,
    category: 'unknown'
  }
}

function isProviderErrorShape(value: unknown): value is ProviderError {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.code === 'string' && typeof record.message === 'string'
}

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError'
}
