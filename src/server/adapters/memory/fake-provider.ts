import type { ProviderPort, ExecuteTaskRequest, ExecuteTaskOutcome } from '../../core/application/ports/provider-registry'
import { createHash } from 'node:crypto'

let turnCounter = 0

export type FakeProviderBehavior =
  | { readonly mode: 'succeed'; readonly resultHash?: string; readonly delayMs?: number }
  | { readonly mode: 'fail'; readonly errorCode?: string }
  | { readonly mode: 'inconclusive'; readonly errorCode?: string }
  | { readonly mode: 'timeout'; readonly delayMs?: number }
  | { readonly mode: 'hang' }
  | {
      readonly mode: 'custom'
      readonly handler: (req: ExecuteTaskRequest) => Promise<ExecuteTaskOutcome>
    }

/**
 * Fake provider for Wave 3/6 tests — no real SDKs.
 */
export class FakeProvider implements ProviderPort {
  behavior: FakeProviderBehavior = { mode: 'succeed' }
  readonly executeCalls: ExecuteTaskRequest[] = []

  constructor(readonly code: string = 'fake') {}

  setBehavior(behavior: FakeProviderBehavior): void {
    this.behavior = behavior
  }

  async discover(): Promise<{ available: boolean }> {
    return { available: true }
  }

  async preflight(_request: unknown): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true }
  }

  async runTurn(_request: unknown): Promise<{ turnId: string }> {
    turnCounter += 1
    return { turnId: `${this.code}-turn-${turnCounter}` }
  }

  async executeTask(request: ExecuteTaskRequest): Promise<ExecuteTaskOutcome> {
    this.executeCalls.push(request)

    if (request.abortSignal?.aborted) {
      return { kind: 'cancelled' }
    }

    const behavior = this.behavior
    switch (behavior.mode) {
      case 'custom':
        return behavior.handler(request)
      case 'fail':
        return { kind: 'failed', errorCode: behavior.errorCode ?? 'fake.failed' }
      case 'inconclusive':
        return {
          kind: 'inconclusive',
          errorCode: behavior.errorCode ?? 'fake.inconclusive'
        }
      case 'timeout':
        await sleep(behavior.delayMs ?? 1, request.abortSignal)
        return { kind: 'timeout' }
      case 'hang':
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            reject(new Error('aborted'))
          }
          if (request.abortSignal?.aborted) {
            onAbort()
            return
          }
          request.abortSignal?.addEventListener('abort', onAbort, { once: true })
          // Never resolves unless aborted.
        })
        return { kind: 'cancelled' }
      case 'succeed':
      default: {
        if (behavior.mode === 'succeed' && behavior.delayMs) {
          await sleep(behavior.delayMs, request.abortSignal)
          if (request.abortSignal?.aborted) return { kind: 'cancelled' }
        }
        const resultHash =
          (behavior.mode === 'succeed' ? behavior.resultHash : undefined) ??
          createHash('sha256')
            .update(`${request.jobId}:${request.taskId}:${request.attemptId}`)
            .digest('hex')
        return { kind: 'succeeded', resultHash, raw: { ok: true, taskId: request.taskId } }
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      },
      { once: true }
    )
  })
}
