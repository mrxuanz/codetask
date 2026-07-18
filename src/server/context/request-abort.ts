import { AsyncLocalStorage } from 'node:async_hooks'

const requestAbortStorage = new AsyncLocalStorage<AbortSignal>()

/** Keep the request cancellation signal available across service/provider async boundaries. */
export function runWithRequestAbortSignal<T>(signal: AbortSignal, run: () => T): T {
  return requestAbortStorage.run(signal, run)
}

export function getCurrentRequestAbortSignal(): AbortSignal | undefined {
  return requestAbortStorage.getStore()
}

export function throwIfCurrentRequestAborted(): void {
  const signal = getCurrentRequestAbortSignal()
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('request.aborted')
  }
}

/** Merge an explicit lifecycle signal with the ambient HTTP request signal, when both exist. */
export function resolveDownstreamAbortSignal(explicit?: AbortSignal): AbortSignal | undefined {
  const requestSignal = getCurrentRequestAbortSignal()
  if (!requestSignal) return explicit
  if (!explicit || explicit === requestSignal) return requestSignal
  return AbortSignal.any([explicit, requestSignal])
}
