import type { ChildProcess } from 'node:child_process'
import type { ActiveSession } from '@agentclientprotocol/sdk'
import type { ConversationRole } from '../roles'
import {
  createTurnError,
  isUserTurnCancellation,
  normalizeTurnError,
  TURN_CANCELLED
} from '../../../shared/turn-errors.ts'
import { isConversationCursorScope } from './runtime-registry'

export const CURSOR_ACP_UPDATE_IDLE_TIMEOUT_MS = 120_000

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
}): void {
  if (input.role !== 'task-worker') return

  if (stderrIndicatesCloudDisconnect(input.stderrTail)) {
    throw createTurnError('provider.cursor.acp_keepalive_timeout')
  }

  if (input.promptSettledError && !isEmptyAcpReply(input.reply)) {
    return
  }

  if (input.promptSettledError || isEmptyAcpReply(input.reply)) {
    throw createTurnError('provider.cursor.acp_empty_turn')
  }
}

export async function awaitAcpSessionUpdate(
  session: ActiveSession,
  options: {
    idleTimeoutMs?: number
    child?: ChildProcess
    isAborted: () => boolean
  }
): Promise<Awaited<ReturnType<ActiveSession['nextUpdate']>>> {
  if (options.isAborted()) {
    throw TURN_CANCELLED
  }

  const idleTimeoutMs = options.idleTimeoutMs ?? CURSOR_ACP_UPDATE_IDLE_TIMEOUT_MS
  let childExitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined

  try {
    return await Promise.race([
      session.nextUpdate(),
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              createTurnError('provider.cursor.acp_keepalive_timeout', {
                detail: `Cursor ACP update idle timeout (${idleTimeoutMs / 1000}s)`
              })
            ),
          idleTimeoutMs
        )
      }),
      ...(options.child
        ? [
            new Promise<never>((_, reject) => {
              childExitListener = (code, signal) => {
                reject(
                  createTurnError('provider.cursor.acp_failed', {
                    detail: `Cursor Agent child exited mid-turn (code=${code ?? 'null'} signal=${signal ?? 'null'})`
                  })
                )
              }
              options.child!.once('exit', childExitListener)
            })
          ]
        : [])
    ])
  } finally {
    if (options.child && childExitListener) {
      options.child.off('exit', childExitListener)
    }
  }
}
