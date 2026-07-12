import type { ConversationRole } from './roles'
import { DEFAULT_SANDBOX_TURN_TIMEOUT_MS } from '../sandbox/session-state'

/** Shared stalled threshold for every role (conversation / planner / task / verifiers). */
export const TASK_TURN_STALLED_MS = 60 * 60_000

/**
 * All roles share the task-worker timeout policy.
 * Planner / verifiers / conversation also call MCP and can run long tool chains;
 * a shorter stalled window mainly caused false kills, not better hang detection.
 */
export function usesTaskTurnTimeoutPolicy(_role: ConversationRole): boolean {
  return true
}

export function stalledAfterMsForRole(role: ConversationRole): number {
  const env = process.env.CODETASK_TURN_STALLED_MS
  if (env) {
    const parsed = Number(env)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  void role
  return TASK_TURN_STALLED_MS
}

/**
 * No short "first signal" kill by default — long MCP / explore startup is normal.
 * Set CODETASK_TURN_NO_FIRST_SIGNAL_MS>0 to re-enable; <=0 keeps it off.
 */
export function noFirstSignalMsForRole(_role: ConversationRole): number | null {
  const env = process.env.CODETASK_TURN_NO_FIRST_SIGNAL_MS
  if (env) {
    const parsed = Number(env)
    if (Number.isFinite(parsed) && parsed <= 0) return null
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

/** Nominal wall hint (sandbox / tooling); shared across roles. */
export function turnWallTimeoutMsForRole(_role: ConversationRole): number | null {
  return DEFAULT_SANDBOX_TURN_TIMEOUT_MS
}
