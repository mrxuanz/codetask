import type { ProviderError, ProviderEvent, ProviderResult } from '../events'
import {
  createFakeProviderRuntimeProfile,
  type ProviderRuntimeProfile
} from '../profile/index.ts'
import type {
  ProviderAdapter,
  ProviderAvailability,
  ProviderPreflightRequest,
  ProviderPreflightResult,
  ProviderTurn,
  ProviderTurnRequest
} from '../types'
import { classifyFakeError } from './classify-error'

let turnSeq = 0

/**
 * Reference Fake Provider adapter — full in-process contract, no SDKs.
 * Use this as the template when adding a new provider (see provider-adapter-guide.md).
 */
export class FakeProviderAdapter implements ProviderAdapter {
  readonly code = 'fake' as const
  readonly stubMode = false

  /** Environment-only profile; no host credential paths; credentialCopy stays false. */
  buildRuntimeProfile(
    overrides: Partial<ProviderRuntimeProfile> = {}
  ): ProviderRuntimeProfile {
    return createFakeProviderRuntimeProfile(overrides)
  }

  async discover(): Promise<ProviderAvailability> {
    return { available: true }
  }

  async preflight(_request?: ProviderPreflightRequest): Promise<ProviderPreflightResult> {
    return { ok: true }
  }

  async runTurn(request?: ProviderTurnRequest): Promise<ProviderTurn> {
    turnSeq += 1
    const turnId = `fake-turn-${turnSeq}`
    const sessionId = request?.sessionId ?? `fake-session-${turnSeq}`
    const prompt = request?.prompt?.trim() || 'hello from fake'
    let cancelled = false
    let closed = false
    let cancelReason: string | undefined

    return {
      turnId,
      sessionId,
      async *stream(signal?: AbortSignal): AsyncIterable<ProviderEvent> {
        if (closed) {
          yield {
            type: 'error',
            error: {
              code: 'fake.closed',
              message: 'turn already closed',
              category: 'protocol',
              retryable: false
            }
          }
          return
        }

        const onAbort = () => {
          cancelled = true
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        request?.abortSignal?.addEventListener('abort', onAbort, { once: true })

        try {
          if (signal?.aborted || request?.abortSignal?.aborted || cancelled) {
            yield {
              type: 'error',
              error: {
                code: 'fake.cancelled',
                message: cancelReason ?? 'turn cancelled',
                category: 'cancelled',
                retryable: false
              }
            }
            return
          }

          yield { type: 'progress', code: 'fake.start', message: 'fake turn started' }
          yield { type: 'reasoning_delta', text: 'considering request' }
          yield { type: 'text_delta', text: prompt }
          yield {
            type: 'tool_started',
            toolCallId: `${turnId}-tool-1`,
            toolName: 'fake.echo'
          }
          yield {
            type: 'tool_finished',
            toolCallId: `${turnId}-tool-1`,
            outcome: 'ok'
          }
          yield { type: 'usage', inputTokens: prompt.length, outputTokens: prompt.length }

          if (cancelled || signal?.aborted) {
            yield {
              type: 'error',
              error: {
                code: 'fake.cancelled',
                message: cancelReason ?? 'turn cancelled',
                category: 'cancelled',
                retryable: false
              }
            }
            return
          }

          const result: ProviderResult = {
            reply: prompt,
            sessionId,
            partial: false
          }
          yield { type: 'result', result }
        } finally {
          signal?.removeEventListener('abort', onAbort)
          request?.abortSignal?.removeEventListener('abort', onAbort)
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

  classifyError(error: unknown): ProviderError {
    return classifyFakeError(error)
  }
}

export function createFakeProviderAdapter(): FakeProviderAdapter {
  return new FakeProviderAdapter()
}
