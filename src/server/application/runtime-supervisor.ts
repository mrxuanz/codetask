import type { SafeLogger } from './ports/safe-logger'
import type { TaskExecutionRegistry } from './task-execution-registry'

export interface RuntimeHandle {
  readonly runtimeInstanceId: string
  readonly runId: string
  readonly closed: Promise<RuntimeExit>
  requestStop(reason: string): Promise<void>
  hardKill(reason: string): Promise<void>
}

export interface RuntimeExit {
  readonly kind: 'normal' | 'error' | 'signal' | 'timeout'
  readonly exitCode?: number
  readonly signal?: string
}

export class RuntimeSupervisor {
  private handles = new Map<string, RuntimeHandle>()
  private closing = false

  constructor(
    private readonly logger: SafeLogger,
    private readonly taskExecutionRegistry?: TaskExecutionRegistry
  ) {}

  register(handle: RuntimeHandle): void {
    this.handles.set(handle.runtimeInstanceId, handle)

    handle.closed
      .then((exit) => {
        this.handles.delete(handle.runtimeInstanceId)
        this.logger.info('Runtime closed', {
          runtimeInstanceId: handle.runtimeInstanceId,
          runId: handle.runId,
          exitKind: exit.kind
        })
      })
      .catch((error: unknown) => {
        this.handles.delete(handle.runtimeInstanceId)
        this.logger.error('Runtime closed with error', {
          runtimeInstanceId: handle.runtimeInstanceId,
          runId: handle.runId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }

  observeClosed(
    handle: RuntimeHandle,
    onClosed: (exit: RuntimeExit) => Promise<void>
  ): Promise<RuntimeExit> {
    return handle.closed.then(async (exit) => {
      await onClosed(exit)
      return exit
    })
  }

  get(runtimeInstanceId: string): RuntimeHandle | undefined {
    return this.handles.get(runtimeInstanceId)
  }

  getByRunId(runId: string): RuntimeHandle | undefined {
    for (const handle of this.handles.values()) {
      if (handle.runId === runId) return handle
    }
    return undefined
  }

  async waitForExternalOperation(operationId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    if (this.taskExecutionRegistry !== undefined) {
      await this.taskExecutionRegistry.waitFor(operationId, signal)
      return
    }
    await Promise.resolve()
  }

  async closeAll(): Promise<void> {
    if (this.closing) return
    this.closing = true

    const handles = Array.from(this.handles.values())
    if (handles.length === 0) return

    this.logger.info('Closing all runtimes', { count: handles.length })

    const promises = handles.map(async (handle) => {
      try {
        await handle.hardKill('app_shutdown')
      } catch (error: unknown) {
        this.logger.error('Failed to kill runtime', {
          runtimeInstanceId: handle.runtimeInstanceId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })

    await Promise.all(promises)
    this.closing = false
  }

  getActiveCount(): number {
    return this.handles.size
  }
}
