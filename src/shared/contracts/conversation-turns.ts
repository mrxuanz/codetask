import type { ConversationMessageDto } from './conversation'
import type { ThreadDto } from './threads'
import type { TurnErrorDto } from './turn-errors'

export type ConversationTurnKind = 'chat'
export type ConversationTurnStatus =
  | 'queued'
  | 'admitted'
  | 'running'
  | 'committing'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'

export interface ConversationTurnDto {
  id: string
  conversationId?: string
  threadId?: string
  username?: string
  actorId?: string
  kind?: ConversationTurnKind
  status?: ConversationTurnStatus
  state?: ConversationTurnStatus
  workspaceAccess: string
  provider?: string | null
  providerCode?: string
  messagePreview?: string
  inputText?: string
  queuePosition: number | null
  stateRevision: number
  lastError: TurnErrorDto | null
  createdAt: number | string
  startedAt?: number | string | null
  completedAt?: number | string | null
}

export interface CreateTurnAcceptedDto {
  turnId: string
  status: ConversationTurnStatus
  revision: number
  queuePosition: number | null
}

export type { ConversationMessageDto, ThreadDto }
