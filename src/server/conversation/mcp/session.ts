import type { MessageAttachment } from '../types'
import { verifyConversationMcpCapabilityToken } from './capability'

/** Conversation MCP is chat-only (architecture 03). */
export type ConversationTurnRole = 'chat'

export interface ConversationMcpSessionContext {
  sessionId: string
  username: string
  threadId: string
  turnRole: ConversationTurnRole
  workspacePath: string
  userMessageId: string
  conversationId: string
  coreCode: string
  turnAttachments: MessageAttachment[]
}

const sessions = new Map<string, ConversationMcpSessionContext>()

export function registerConversationMcpSession(context: ConversationMcpSessionContext): void {
  sessions.set(context.sessionId, context)
}

export function unregisterConversationMcpSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function getConversationMcpSession(sessionId: string): ConversationMcpSessionContext | null {
  return sessions.get(sessionId) ?? null
}

export function authorizeConversationMcpRequest(input: {
  sessionId: string
  role?: string | null
  threadId?: string | null
  capability?: string | null
}): boolean {
  if (input.role?.trim() !== 'conversation') return false
  const threadId = input.threadId?.trim()
  if (!threadId) return false

  const session = getConversationMcpSession(input.sessionId)
  if (!session) return false
  if (session.threadId !== threadId) return false

  return verifyConversationMcpCapabilityToken(input.capability, session.sessionId, session.threadId)
}
