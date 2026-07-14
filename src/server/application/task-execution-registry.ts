import type {
  TaskExecutionOutcome,
  TaskExecutionProvider,
  TaskExecutionRequest
} from './ports/task-execution-provider'

type PendingWaiter = {
  readonly resolve: () => void
  readonly abortListener: () => void
}

/**
 * Holds in-flight task work until an external reporter (e.g. MCP) delivers a result.
 * Production executor uses this path — it never synthesizes completed payloads.
 */
export class TaskExecutionRegistry {
  private readonly pendingResults = new Map<string, TaskExecutionOutcome>()
  private readonly waiters = new Map<string, PendingWaiter>()

  waitFor(operationId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    if (this.pendingResults.has(operationId)) return Promise.resolve()

    return new Promise((resolve) => {
      const onAbort = (): void => {
        this.waiters.delete(operationId)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.set(operationId, { resolve, abortListener: onAbort })
    })
  }

  deliver(operationId: string, outcome: TaskExecutionOutcome): boolean {
    this.pendingResults.set(operationId, outcome)
    const waiter = this.waiters.get(operationId)
    if (waiter === undefined) return false
    this.waiters.delete(operationId)
    waiter.resolve()
    return true
  }

  takePending(operationId: string): TaskExecutionOutcome | null {
    const cached = this.pendingResults.get(operationId)
    if (cached === undefined) return null
    this.pendingResults.delete(operationId)
    return cached
  }
}

export function createRegistryTaskExecutionProvider(
  registry: TaskExecutionRegistry
): TaskExecutionProvider {
  return {
    async executeTask(request: TaskExecutionRequest): Promise<TaskExecutionOutcome> {
      const operationId = request.attemptId
      const pending = registry.takePending(operationId)
      if (pending !== null) {
        return pending
      }
      return { kind: 'waiting', externalOperationId: operationId }
    }
  }
}
