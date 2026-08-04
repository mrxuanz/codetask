export type {
  ConversationCoreDto,
  ConversationStateDto,
  MessageAttachment
} from '@codetask/contracts'
import type { MessageAttachment } from '@codetask/contracts'

/**
 * Legacy thread_messages row mapping (removed with R5 DROP).
 * Prefer wire ConversationMessageDto from @codetask/contracts for HTTP.
 */
export type ConversationMessageDto = {
  id: string
  role: 'user' | 'assistant' | 'system' | string
  kind: 'text' | string
  content: string
  attachments: MessageAttachment[]
  coreCode: string
  sessionId?: string | null
  conversationId?: string | null
  runtimeSessionId?: string | null
  thinking?: string | null
  thinkingDurationMs?: number | null
  payload?: unknown
  createdAt: string
}

export type { ConversationRole } from '../agent-runtime/roles'
