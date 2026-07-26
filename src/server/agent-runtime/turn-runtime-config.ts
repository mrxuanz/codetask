import { DEFAULT_SANDBOX_TURN_TIMEOUT_MS } from '../sandbox/session-state'

/**
 * Sandbox/Provider execution policy.
 *
 * These are application-owned TypeScript values. They are deliberately not
 * inferred from process environment variables or a mutable business settings store.
 */
export interface TurnRuntimeConfig {
  readonly maxRetries: number
  readonly absoluteMaxRetries: number
  readonly progressWindowMs: number
  readonly stalledMs: number
  readonly noFirstSignalMs: number | null
  readonly longRunningToolCapMs: number
}

export const DEFAULT_TURN_RUNTIME_CONFIG: TurnRuntimeConfig = Object.freeze({
  maxRetries: 3,
  absoluteMaxRetries: 5,
  progressWindowMs: 5 * 60_000,
  stalledMs: 60 * 60_000,
  noFirstSignalMs: null,
  longRunningToolCapMs: DEFAULT_SANDBOX_TURN_TIMEOUT_MS
})
