/**
 * Shared work execution context (重构.md §6.2).
 */
export interface WorkContext {
  readonly actorId?: string
  readonly requestId: string
  readonly idempotencyKey: string
  readonly signal: AbortSignal
}

export function resolveWorkSignal(
  context: WorkContext | undefined,
  signal?: AbortSignal
): AbortSignal {
  return context?.signal ?? signal ?? new AbortController().signal
}

export function assertNotAborted(signal: AbortSignal, message = 'Work aborted'): void {
  if (signal.aborted) {
    const reason = signal.reason
    const detail =
      reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : message
    const error = new Error(detail)
    error.name = 'AbortError'
    ;(error as Error & { code: string }).code = 'work.aborted'
    throw error
  }
}
