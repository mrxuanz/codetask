import type { ConversationRole } from './roles'
import { DEFAULT_SANDBOX_TURN_TIMEOUT_MS } from '../sandbox/session-state'

export const TASK_TURN_STALLED_MS = 60 * 60_000
const LEGACY_NO_FIRST_SIGNAL_MS = 120_000

export function usesTaskTurnTimeoutPolicy(role: ConversationRole): boolean {
  return role === 'task-worker' || role === 'conversation'
}

export function stalledAfterMsForRole(role: ConversationRole): number {
  const env = process.env.CODETASK_TURN_STALLED_MS
  if (env) {
    const parsed = Number(env)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  if (usesTaskTurnTimeoutPolicy(role)) return TASK_TURN_STALLED_MS
  if (role === 'planner') return 20 * 60_000
  if (role === 'milestone-verifier' || role === 'slice-verifier') return 15 * 60_000
  return 20 * 60_000
}

export function noFirstSignalMsForRole(role: ConversationRole): number | null {
  const env = process.env.CODETASK_TURN_NO_FIRST_SIGNAL_MS
  if (env) {
    const parsed = Number(env)
    if (Number.isFinite(parsed) && parsed <= 0) return null
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  if (usesTaskTurnTimeoutPolicy(role)) {
    return null
  }
  return LEGACY_NO_FIRST_SIGNAL_MS
}

export function turnWallTimeoutMsForRole(role: ConversationRole): number | null {
  if (!usesTaskTurnTimeoutPolicy(role)) return null
  return DEFAULT_SANDBOX_TURN_TIMEOUT_MS
}
