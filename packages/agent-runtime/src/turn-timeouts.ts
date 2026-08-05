import type { ConversationRole } from './roles.ts'

/** Nominal wall hint (sandbox / tooling); shared across roles. */
export const DEFAULT_SANDBOX_TURN_TIMEOUT_MS = 30 * 60 * 1000

export interface TurnTimeoutDefaults {
  readonly stalledMs: number
  readonly noFirstSignalMs: number | null
}

export const DEFAULT_TURN_TIMEOUTS: TurnTimeoutDefaults = {
  stalledMs: 60 * 60_000,
  noFirstSignalMs: null
}

/** Shared stalled threshold for every role (conversation / planner / task / verifiers). */
export const TASK_TURN_STALLED_MS = DEFAULT_TURN_TIMEOUTS.stalledMs

export function usesTaskTurnTimeoutPolicy(_role: ConversationRole): boolean {
  return true
}

export function stalledAfterMsForRole(
  role: ConversationRole,
  stalledMs = TASK_TURN_STALLED_MS
): number {
  void role
  return stalledMs
}

export function noFirstSignalMsForRole(
  _role: ConversationRole,
  noFirstSignalMs = DEFAULT_TURN_TIMEOUTS.noFirstSignalMs
): number | null {
  return noFirstSignalMs
}

export function turnWallTimeoutMsForRole(_role: ConversationRole): number | null {
  return DEFAULT_SANDBOX_TURN_TIMEOUT_MS
}
