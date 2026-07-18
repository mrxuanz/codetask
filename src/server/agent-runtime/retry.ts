import { sandboxTurnDebug } from '../debug/sandbox-turn'
import { TURN_CANCELLED } from '../../shared/turn-errors.ts'
import {
  isCapacityTurnError,
  isRetryableTurnError,
  isUserTurnCancellation
} from '../../shared/turn-errors.ts'
import { isTurnError, createTurnError } from '../../shared/turn-errors.ts'
import type { AgentTurnChunk } from './types'
import { DEFAULT_APP_CONFIG } from '../config/app-config'

const DEFAULT_MAX_RETRIES = DEFAULT_APP_CONFIG.turn.maxRetries
const ABSOLUTE_MAX_RETRIES = DEFAULT_APP_CONFIG.turn.absoluteMaxRetries

function turnErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function resolveTurnMaxRetries(configured = DEFAULT_MAX_RETRIES): number {
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_MAX_RETRIES
  return Math.min(Math.floor(configured), ABSOLUTE_MAX_RETRIES)
}

export { isRetryableTurnError } from '../../shared/turn-errors.ts'

export function turnRetryDelayMs(attempt: number, error: unknown): number {
  if (isCapacityTurnError(error)) {
    return Math.min(30_000 * attempt, 90_000)
  }
  const baseMs = 2_000 * 2 ** Math.max(0, attempt - 1)
  return Math.min(baseMs, 60_000)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : TURN_CANCELLED)
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : TURN_CANCELLED)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function rethrowTurnChunkError(chunk: Extract<AgentTurnChunk, { type: 'error' }>): never {
  if (chunk.error) {
    throw createTurnError(chunk.error.code, {
      params: chunk.error.params,
      detail: chunk.error.detail ?? undefined,
      message: chunk.error.message
    })
  }
  throw createTurnError('turn.unknown', { detail: chunk.message, message: chunk.message })
}

export async function* streamWithTurnRetry(
  run: () => AsyncGenerator<AgentTurnChunk>,
  options?: { signal?: AbortSignal | undefined; maxAttempts?: number; label?: string }
): AsyncGenerator<AgentTurnChunk> {
  const maxAttempts = options?.maxAttempts ?? resolveTurnMaxRetries()
  const signal = options?.signal
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let completed = false
    try {
      for await (const chunk of run()) {
        if (chunk.type === 'error') {
          rethrowTurnChunkError(chunk)
        }
        yield chunk
        if (chunk.type === 'completed') {
          completed = true
          return
        }
      }
      if (!completed) {
        throw createTurnError('turn.incomplete')
      }
      return
    } catch (error) {
      lastError = error
      if (isUserTurnCancellation(error)) {
        throw error
      }
      if (!isRetryableTurnError(error) || attempt >= maxAttempts) {
        throw error
      }

      const delayMs = turnRetryDelayMs(attempt, error)
      sandboxTurnDebug('turn-retry: scheduling retry', {
        label: options?.label ?? null,
        attempt,
        maxAttempts,
        delayMs,
        code: isTurnError(error) ? error.code : undefined,
        message: turnErrorMessage(error)
      })
      await sleep(delayMs, signal)
      sandboxTurnDebug('turn-retry: retrying turn', {
        label: options?.label ?? null,
        attempt: attempt + 1,
        maxAttempts
      })
    }
  }

  if (lastError) {
    throw lastError
  }
}
