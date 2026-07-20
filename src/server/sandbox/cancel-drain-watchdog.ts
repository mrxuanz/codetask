/**
 * Bounded cancel drain: after soft cancel, escalate if the session never leaves
 * the active set. Used by the supervisor child (process exit) and the parent
 * client (supervisor recycle).
 */
export function armCancelDrainWatchdog(input: {
  timeoutMs: number
  isStale: () => boolean
  onTimeout: () => void
}): { clear: () => void } {
  const timer = setTimeout(() => {
    if (input.isStale()) return
    input.onTimeout()
  }, input.timeoutMs)
  timer.unref?.()
  return {
    clear: () => clearTimeout(timer)
  }
}

export const SUPERVISOR_CANCEL_DRAIN_TIMEOUT_MS = 15_000
export const CLIENT_CANCEL_DRAIN_TIMEOUT_MS = 20_000
