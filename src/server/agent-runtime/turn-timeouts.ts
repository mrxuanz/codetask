import type { ConversationRole } from './roles'
import { DEFAULT_SANDBOX_TURN_TIMEOUT_MS } from '../sandbox/session-state'
import { DEFAULT_APP_CONFIG } from '../config/app-config'

/** Shared stalled threshold for every role (conversation / planner / task / verifiers). */
export const TASK_TURN_STALLED_MS = DEFAULT_APP_CONFIG.turn.stalledMs

/**
 * All roles share the task-worker timeout policy.
 * Planner / verifiers / conversation also call MCP and can run long tool chains;
 * a shorter stalled window mainly caused false kills, not better hang detection.
 */
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

/**
 * No short "first signal" kill by default — long MCP / explore startup is normal.
 */
export function noFirstSignalMsForRole(
  _role: ConversationRole,
  noFirstSignalMs = DEFAULT_APP_CONFIG.turn.noFirstSignalMs
): number | null {
  return noFirstSignalMs
}

/** Nominal wall hint (sandbox / tooling); shared across roles. */
export function turnWallTimeoutMsForRole(_role: ConversationRole): number | null {
  return DEFAULT_SANDBOX_TURN_TIMEOUT_MS
}
