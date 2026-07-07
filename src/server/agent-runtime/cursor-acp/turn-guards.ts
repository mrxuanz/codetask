import type { ConversationRole } from '../roles'
import {
  createTurnError,
  isUserTurnCancellation,
  normalizeTurnError
} from '../../../shared/turn-errors.ts'
import { isConversationCursorScope } from './runtime-registry'

export function isEmptyAcpReply(reply: string): boolean {
  return !reply.trim()
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

function stderrIndicatesCloudDisconnect(stderrTail: string): boolean {
  const lower = stderrTail.toLowerCase()
  return (
    lower.includes('keepalive') ||
    lower.includes('http/2') ||
    lower.includes('stream ended without turnended') ||
    lower.includes('retriableerror') ||
    lower.includes('connecterror')
  )
}

export function assertTaskWorkerAcpCompletion(input: {
  role: ConversationRole
  reply: string
  stderrTail: string
  promptSettledError: unknown | null
}): { partial?: true } {
  if (input.role !== 'task-worker') return {}

  if (stderrIndicatesCloudDisconnect(input.stderrTail)) {
    throw createTurnError('provider.cursor.acp_keepalive_timeout')
  }

  if (input.promptSettledError && !isEmptyAcpReply(input.reply)) {
    return { partial: true }
  }

  if (input.promptSettledError || isEmptyAcpReply(input.reply)) {
    throw createTurnError('provider.cursor.acp_empty_turn')
  }

  return {}
}
