/**
 * List-row shape for sidebar (1:1 from ConversationDto).
 */
import type { TitleSource } from './conversation.ts'
import type { ProviderCode } from './execution.ts'

export type ConversationListItemDto = {
  id: string
  projectId: string
  actorId: string
  title: string
  titleSource: TitleSource
  status: string
  conversationId: string
  providerCode: ProviderCode | string
  runtimeStatus: string
  runtimeSessionId: string | null
  lastError: { code: string; message: string } | null
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

/** @deprecated Use ConversationListItemDto */
export type ThreadDto = ConversationListItemDto
