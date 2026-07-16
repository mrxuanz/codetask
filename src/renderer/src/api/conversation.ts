import type {
  ConversationCoreDto,
  ConversationMessageDto,
  ConversationStateDto,
  ConversationTurnDto,
  CreateTurnAcceptedDto
} from '@shared/contracts'
import { api } from './client'
import type { ApiResponse } from './types'

export type {
  ChatSseEvent,
  ConversationCoreDto as ConversationCore,
  ConversationMessageDto as ConversationMessage,
  ConversationStateDto as ConversationState
} from '@shared/contracts'

export function fetchConversationCores(): Promise<ApiResponse<{ cores: ConversationCoreDto[] }>> {
  return api<{ cores: ConversationCoreDto[] }>('/api/agent/cores')
}

export function fetchThreadConversationState(
  threadId: string
): Promise<ApiResponse<ConversationStateDto>> {
  return api<ConversationStateDto>(`/api/threads/${threadId}/agent`)
}

export function fetchThreadMessages(
  threadId: string,
  limit = 50
): Promise<ApiResponse<{ messages: ConversationMessageDto[] }>> {
  const params = new URLSearchParams({ limit: String(limit) })
  return api<{ messages: ConversationMessageDto[] }>(`/api/threads/${threadId}/messages?${params}`)
}

export function createThreadTurn(
  threadId: string,
  message: string,
  options?: {
    generateDraft?: boolean
    createTaskMode?: boolean
    attachmentIds?: string[]
    selectedDraftSection?: string
    selectedPlanNodeRef?: string
    idempotencyKey?: string
    allowCodeChanges?: boolean
  }
): Promise<ApiResponse<CreateTurnAcceptedDto>> {
  return api<CreateTurnAcceptedDto>(`/api/threads/${threadId}/turns`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      generateDraft: options?.generateDraft === true,
      createTaskMode: options?.createTaskMode === true,
      attachmentIds: options?.attachmentIds ?? [],
      selectedDraftSection: options?.selectedDraftSection,
      selectedPlanNodeRef: options?.selectedPlanNodeRef,
      idempotencyKey: options?.idempotencyKey,
      allowCodeChanges: options?.allowCodeChanges === true
    })
  })
}

export function fetchThreadTurn(
  threadId: string,
  turnId: string
): Promise<ApiResponse<{ turn: ConversationTurnDto }>> {
  return api<{ turn: ConversationTurnDto }>(`/api/threads/${threadId}/turns/${turnId}`)
}

export function cancelThreadTurn(
  threadId: string,
  turnId: string
): Promise<ApiResponse<{ turn: ConversationTurnDto }>> {
  return api<{ turn: ConversationTurnDto }>(`/api/threads/${threadId}/turns/${turnId}/cancel`, {
    method: 'POST'
  })
}
