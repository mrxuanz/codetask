import type { ProviderEvent, ProviderResult } from './events'
import type { ProviderTurn, ProviderTurnRequest } from './types'

export type StubTurnOptions = {
  readonly code: string
  readonly request?: ProviderTurnRequest
  readonly reply?: string
}

/**
 * Shared production-shaped turn handle used by stub adapters.
 * Real SDK wiring replaces createStubTurn internals later; the public turn API stays.
 */
export function createStubTurn(options: StubTurnOptions): ProviderTurn {
  let cancelled = false
  let closed = false
  let cancelReason: string | undefined
  const turnId = `${options.code}-turn-${Date.now().toString(36)}`
  const sessionId = options.request?.sessionId ?? `${options.code}-session-stub`
  const reply =
    options.reply ??
    `[${options.code}:stub] ${options.request?.prompt?.trim() || 'ok'}`

  return {
    turnId,
    sessionId,
    async *stream(signal?: AbortSignal): AsyncIterable<ProviderEvent> {
      if (closed) {
        yield {
          type: 'error',
          error: {
            code: `${options.code}.closed`,
            message: 'turn already closed',
            category: 'protocol',
            retryable: false
          }
        }
        return
      }

      const abort = () => {
        cancelled = true
      }
      signal?.addEventListener('abort', abort, { once: true })
      options.request?.abortSignal?.addEventListener('abort', abort, { once: true })

      try {
        if (signal?.aborted || options.request?.abortSignal?.aborted || cancelled) {
          yield {
            type: 'error',
            error: {
              code: `${options.code}.cancelled`,
              message: cancelReason ?? 'turn cancelled',
              category: 'cancelled',
              retryable: false
            }
          }
          return
        }

        yield { type: 'progress', code: 'stub.start', message: `${options.code} stub turn` }
        yield { type: 'text_delta', text: reply }

        if (cancelled || signal?.aborted) {
          yield {
            type: 'error',
            error: {
              code: `${options.code}.cancelled`,
              message: cancelReason ?? 'turn cancelled',
              category: 'cancelled',
              retryable: false
            }
          }
          return
        }

        const result: ProviderResult = { reply, sessionId, partial: false }
        yield { type: 'result', result }
      } finally {
        signal?.removeEventListener('abort', abort)
        options.request?.abortSignal?.removeEventListener('abort', abort)
      }
    },
    async cancel(reason?: string): Promise<void> {
      cancelled = true
      cancelReason = reason
    },
    async close(): Promise<void> {
      closed = true
      cancelled = true
    }
  }
}
