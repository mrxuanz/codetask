/**
 * Thin bridge: Wave 7C ProviderAdapter → application ProviderPort.
 * Domain/workflows stay on ProviderPort; adapters keep the runTurn/stream surface.
 */

import { createHash } from 'node:crypto'
import type {
  ExecuteTaskOutcome,
  ExecuteTaskRequest,
  ProviderPort,
  ProviderRegistryPort
} from '../../core/application/ports/provider-registry'
import type { ProviderError } from './events'
import type {
  ProviderAdapter,
  ProviderPreflightRequest,
  ProviderRegistry,
  ProviderTurnRequest
} from './types'

function hashResult(payload: string): string {
  return createHash('sha256').update(payload).digest('hex')
}

function outcomeFromError(error: ProviderError): ExecuteTaskOutcome {
  if (error.category === 'cancelled') {
    return { kind: 'cancelled' }
  }
  if (error.category === 'timeout') {
    return { kind: 'timeout' }
  }
  if (error.category === 'availability') {
    return { kind: 'inconclusive', errorCode: error.code }
  }
  return { kind: 'failed', errorCode: error.code }
}

export function asProviderPort(adapter: ProviderAdapter): ProviderPort {
  return {
    code: adapter.code,

    async discover(): Promise<{ available: boolean }> {
      const availability = await adapter.discover()
      return { available: availability.available }
    },

    async preflight(request: unknown): Promise<{ ok: boolean; reason?: string }> {
      const result = await adapter.preflight(request as ProviderPreflightRequest | undefined)
      return { ok: result.ok, reason: result.reason }
    },

    async runTurn(request: unknown): Promise<{ turnId: string }> {
      const turn = await adapter.runTurn(request as ProviderTurnRequest | undefined)
      return { turnId: turn.turnId }
    },

    async executeTask(request: ExecuteTaskRequest): Promise<ExecuteTaskOutcome> {
      if (request.abortSignal?.aborted) {
        return { kind: 'cancelled' }
      }

      const turnRequest: ProviderTurnRequest = {
        prompt: request.title?.trim() || request.taskId,
        abortSignal: request.abortSignal
      }

      let turn
      try {
        turn = await adapter.runTurn(turnRequest)
      } catch (error) {
        return outcomeFromError(adapter.classifyError(error))
      }

      try {
        for await (const event of turn.stream(request.abortSignal)) {
          if (event.type === 'result') {
            const reply = event.result.reply
            const resultHash = hashResult(
              reply.length > 0
                ? reply
                : `${request.jobId}:${request.taskId}:${request.attemptId}`
            )
            return {
              kind: 'succeeded',
              resultHash,
              raw: event.result
            }
          }
          if (event.type === 'error') {
            return outcomeFromError(event.error)
          }
        }
        return {
          kind: 'inconclusive',
          errorCode: `${adapter.code}.no_terminal_event`
        }
      } catch (error) {
        return outcomeFromError(adapter.classifyError(error))
      } finally {
        await turn.close().catch(() => undefined)
      }
    }
  }
}

export function asProviderRegistryPort(registry: ProviderRegistry): ProviderRegistryPort {
  return {
    get(code: string): ProviderPort | undefined {
      const adapter = registry.get(code)
      return adapter ? asProviderPort(adapter) : undefined
    }
  }
}
