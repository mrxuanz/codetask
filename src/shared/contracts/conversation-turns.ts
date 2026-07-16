import type { ChatSseEvent } from './sse'
import type { ConversationMessageDto } from './conversation'
import type { ThreadDto } from './threads'
import type { TurnErrorDto } from './turn-errors'

export type ConversationTurnKind = 'chat' | 'create_task' | 'draft'
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
  threadId: string
  username: string
  kind: ConversationTurnKind
  status: ConversationTurnStatus
  workspaceAccess: string
  provider: string | null
  changeSetId: string | null
  messagePreview: string
  queuePosition: number | null
  stateRevision: number
  lastError: TurnErrorDto | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface CreateTurnAcceptedDto {
  turnId: string
  status: ConversationTurnStatus
  revision: number
  queuePosition: number | null
  changeSetId: string | null
}

export type TurnHubEvent =
  | { event: 'turn_snapshot'; data: { turn: ConversationTurnDto } }
  | ChatSseEvent

export type { ConversationMessageDto, ThreadDto }
