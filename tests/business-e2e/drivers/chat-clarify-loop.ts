import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { McpToolClient } from '../mcp/client'
import { waitForTurnTerminalViaMcp } from './turn-wait'

/** Initial turn + up to 3 clarification follow-ups. */
export const MAX_CHAT_TURNS = 4

export type ChatClarifyPush = (type: string, detail?: unknown) => void

export type ChatClarifyLoopResult = {
  turnIds: string[]
  turnsUsed: number
  lastTurnStatus: string
  lastAssistantText: string
  clarified: boolean
}

/**
 * Heuristic: assistant is asking for more detail instead of finishing the task.
 * Keep narrow — false positives burn a follow-up turn; false negatives fail the oracle.
 */
export function looksLikeClarificationRequest(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  const lower = t.toLowerCase()

  // Short numeric / exact answers are never clarification.
  if (/^[\d.\s]+$/.test(t) && t.length <= 8) return false

  const askPatterns = [
    /需要(?:我|您|你)?(?:提供|补充|确认|说明)/,
    /请(?:提供|补充|确认|告诉我|告知)/,
    /能否(?:提供|告诉|说明)/,
    /方便(?:提供|告诉)/,
    /更多(?:细节|信息|上下文|需求)/,
    /哪(?:些|个)(?:文件|路径|格式|要求)/,
    /你想(?:要|让)/,
    /是否(?:需要|要|可以)/,
    /clarif(?:y|ication)/i,
    /could you (?:provide|clarify|confirm|tell)/i,
    /can you (?:provide|clarify|confirm|tell)/i,
    /more (?:details?|info(?:rmation)?|context)/i,
    /which (?:file|path|format)/i,
    /what (?:exactly|specifically)/i
  ]
  if (askPatterns.some((re) => re.test(t))) return true

  // Question-heavy short replies without claiming completion.
  const questionMarks = (t.match(/[？?]/g) ?? []).length
  const claimsDone = /已(?:创建|完成|写入|生成)|created|done|finished|wrote/i.test(t)
  if (questionMarks >= 1 && t.length < 280 && !claimsDone) return true

  // "I need…" without producing the deliverable.
  if (
    /(?:i need|i'll need|let me know|please specify)/i.test(lower) &&
    !claimsDone &&
    t.length < 400
  ) {
    return true
  }

  return false
}

export function latestAssistantText(messages: unknown): string {
  const list = Array.isArray(messages)
    ? messages
    : messages &&
        typeof messages === 'object' &&
        Array.isArray((messages as { data?: unknown }).data)
      ? ((messages as { data: Array<Record<string, unknown>> }).data ?? [])
      : messages &&
          typeof messages === 'object' &&
          Array.isArray((messages as { messages?: unknown }).messages)
        ? ((messages as { messages: Array<Record<string, unknown>> }).messages ?? [])
        : []

  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (!item || typeof item !== 'object') continue
    if (String(item.role ?? '') !== 'assistant') continue
    const content = item.content
    if (typeof content === 'string' && content.trim()) return content
  }
  return ''
}

function normalizeMessageList(messages: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(messages)) return messages as Array<Record<string, unknown>>
  if (messages && typeof messages === 'object') {
    const record = messages as { data?: unknown; messages?: unknown }
    if (Array.isArray(record.data)) return record.data as Array<Record<string, unknown>>
    if (Array.isArray(record.messages)) return record.messages as Array<Record<string, unknown>>
  }
  return []
}

/**
 * Run up to {@link MAX_CHAT_TURNS} conversation turns.
 * After each completed turn: if the assistant asks for details, send `clarifyMessage`
 * and continue; otherwise stop so the caller can run case-specific oracles.
 */
export async function runChatWithClarificationLoop(
  mcp: McpToolClient,
  input: {
    threadId: string
    initialMessage: string
    clarifyMessage: string
    attachmentIds?: string[]
    /** Optional early-success check (e.g. expected file already written). */
    isSatisfied?: () => boolean | Promise<boolean>
    push?: ChatClarifyPush
    maxTurns?: number
  }
): Promise<ChatClarifyLoopResult> {
  const maxTurns = Math.min(Math.max(input.maxTurns ?? MAX_CHAT_TURNS, 1), MAX_CHAT_TURNS)
  const turnIds: string[] = []
  let lastTurnStatus = ''
  let lastAssistantText = ''
  let clarified = false
  let nextMessage = input.initialMessage
  let attachOnce = Boolean(input.attachmentIds?.length)

  for (let turnIndex = 1; turnIndex <= maxTurns; turnIndex++) {
    const started = (await mcp.callTool('codetask_start_turn', {
      threadId: input.threadId,
      message: nextMessage,
      ...(attachOnce && input.attachmentIds ? { attachmentIds: input.attachmentIds } : {})
    })) as { turnId: string }
    attachOnce = false
    turnIds.push(started.turnId)

    const turn = (await waitForTurnTerminalViaMcp(mcp, {
      threadId: input.threadId,
      turnId: started.turnId,
      onRetry: ({ attempt, error }) =>
        input.push?.('turn.wait_retry', { attempt, error, turnIndex })
    })) as { status?: string; lastError?: unknown }

    lastTurnStatus = String(turn.status ?? '')
    input.push?.('turn.done', {
      status: lastTurnStatus,
      turnId: started.turnId,
      turnIndex,
      turnsUsed: turnIndex
    })

    if (lastTurnStatus !== 'completed') {
      throw new Error(
        `turn_not_completed:${lastTurnStatus}:${JSON.stringify(turn.lastError ?? null)}`
      )
    }

    const messages = await mcp.callTool('codetask_list_messages', { threadId: input.threadId })
    lastAssistantText = latestAssistantText(messages)

    if (input.isSatisfied && (await input.isSatisfied())) {
      input.push?.('chat.goal_met', { turnIndex, turnsUsed: turnIndex })
      return {
        turnIds,
        turnsUsed: turnIndex,
        lastTurnStatus,
        lastAssistantText,
        clarified
      }
    }

    const needsClarify = looksLikeClarificationRequest(lastAssistantText)
    if (!needsClarify || turnIndex >= maxTurns) {
      if (needsClarify && turnIndex >= maxTurns) {
        input.push?.('chat.clarify_exhausted', {
          turnIndex,
          preview: lastAssistantText.slice(0, 240)
        })
      }
      return {
        turnIds,
        turnsUsed: turnIndex,
        lastTurnStatus,
        lastAssistantText,
        clarified
      }
    }

    clarified = true
    nextMessage = input.clarifyMessage
    input.push?.('chat.clarify_followup', {
      turnIndex,
      nextTurn: turnIndex + 1,
      preview: lastAssistantText.slice(0, 240)
    })
  }

  return {
    turnIds,
    turnsUsed: turnIds.length,
    lastTurnStatus,
    lastAssistantText,
    clarified
  }
}

/** Convenience for HTML create cases. */
export function htmlFileSatisfied(workspaceRoot: string, fileName: string): boolean {
  return existsSync(join(workspaceRoot, fileName))
}

export function listAssistantTexts(messages: unknown): string[] {
  return normalizeMessageList(messages)
    .filter((item) => String(item.role ?? '') === 'assistant')
    .map((item) => (typeof item.content === 'string' ? item.content : ''))
    .filter(Boolean)
}
