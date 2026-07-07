import { AsyncLocalStorage } from 'node:async_hooks'

export interface ExecutionRunContext {
  runId: string
  signal: AbortSignal
}

const storage = new AsyncLocalStorage<ExecutionRunContext>()

export function runWithExecutionRunContext<T>(
  ctx: ExecutionRunContext,
  fn: () => Promise<T>
): Promise<T> {
  return storage.run(ctx, fn)
}

export function getExecutionRunContext(): ExecutionRunContext | undefined {
  return storage.getStore()
}

export function resetExecutionRunContextForTests(): void {
  storage.disable()
}
