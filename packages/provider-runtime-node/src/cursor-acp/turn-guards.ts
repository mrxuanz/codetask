import type { ConversationRole } from '@server/agent-runtime/roles'
import {
  createTurnError,
  indicatesCursorAcpKeepaliveTimeout,
  indicatesCursorProviderCapacity,
  isUserTurnCancellation,
  normalizeTurnError,
  type TurnError
} from '@shared/turn-errors/index.ts'

export function isEmptyAcpReply(reply: string): boolean {
  return !reply.trim()
}

/** Avoid importing runtime-registry from this light guard module. */
function isConversationCursorScope(scopeId: string): boolean {
  return (
    scopeId.startsWith('conversation:chat:') ||
    /^conversation:[^:]+$/.test(scopeId) ||
    /^conversation:[^:]+:provider:[^:]+$/.test(scopeId)
  )
}

export function shouldInvalidateCursorScopedRuntime(
  role: ConversationRole,
  scopeId: string,
  error: unknown
): boolean {
  if (!scopeId || !isConversationCursorScope(scopeId) || role !== 'conversation') {
    return true
  }
  if (isUserTurnCancellation(error)) {
    return false
  }

  const normalized = normalizeTurnError(error)
  switch (normalized.code) {
    case 'provider.cursor.not_authenticated':
    case 'provider.cursor.cli_missing':
      return true
    case 'provider.cursor.acp_empty_turn':
    case 'turn.capacity_limited':
    case 'provider.cursor.acp_keepalive_timeout':
      return false
    case 'provider.cursor.acp_failed': {
      const detail = (normalized.detail ?? normalized.message).toLowerCase()
      return (
        detail.includes('child exited') ||
        detail.includes('not ready') ||
        detail.includes('runtime closed') ||
        detail.includes('not connected')
      )
    }
    default:
      return false
  }
}

export function stderrIndicatesCursorCloudFailure(stderrTail: string): boolean {
  return (
    indicatesCursorProviderCapacity(stderrTail) || indicatesCursorAcpKeepaliveTimeout(stderrTail)
  )
}

function cloudFailureFromStderr(stderrTail: string): TurnError {
  const detail = stderrTail.trim().slice(-600) || undefined
  if (indicatesCursorProviderCapacity(stderrTail)) {
    return createTurnError('turn.capacity_limited', { detail })
  }
  return createTurnError('provider.cursor.acp_keepalive_timeout', { detail })
}

const ROLES_REQUIRING_NONEMPTY_REPLY: ReadonlySet<ConversationRole> = new Set([
  'task-worker',
  'milestone-verifier',
  'slice-verifier'
])

/**
 * Cursor ACP may report a clean stop while stderr shows a cloud disconnect.
 * Task/verifier roles also treat empty replies as incomplete turns.
 * Planner / conversation may finish with empty assistant text (server commits plan).
 */
export function assertCursorAcpCompletion(input: {
  role: ConversationRole
  reply: string
  stderrTail: string
  promptSettledError: unknown | null
}): { partial?: true } {
  if (stderrIndicatesCursorCloudFailure(input.stderrTail)) {
    throw cloudFailureFromStderr(input.stderrTail)
  }

  if (input.role === 'planner' || input.role === 'conversation') {
    return {}
  }

  if (!ROLES_REQUIRING_NONEMPTY_REPLY.has(input.role)) {
    return {}
  }

  if (input.promptSettledError && !isEmptyAcpReply(input.reply)) {
    return { partial: true }
  }

  if (input.promptSettledError || isEmptyAcpReply(input.reply)) {
    throw createTurnError('provider.cursor.acp_empty_turn')
  }

  return {}
}
