import { authHeaders } from '@renderer/auth/token'
import type {
  ChatSseEvent,
  ConversationCoreDto,
  ConversationMessageDto,
  ConversationStateDto
} from '@shared/contracts'
import { api, ApiError } from './client'
import type { ApiResponse } from './types'
import { throwIfNotSseResponse } from './sse'

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

export async function streamThreadMessage(
  threadId: string,
  message: string,
  onEvent: (event: ChatSseEvent) => void,
  options?: {
    generateDraft?: boolean
    createTaskMode?: boolean
    attachmentIds?: string[]
    selectedDraftSection?: string
    selectedPlanNodeRef?: string
  }
): Promise<void> {
  const res = await fetch(`/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...authHeaders()
    },
    body: JSON.stringify({
      message,
      generateDraft: options?.generateDraft === true,
      createTaskMode: options?.createTaskMode === true,
      attachmentIds: options?.attachmentIds ?? [],
      selectedDraftSection: options?.selectedDraftSection,
      selectedPlanNodeRef: options?.selectedPlanNodeRef
    })
  })

  await throwIfNotSseResponse(res)

  const reader = res.body?.getReader()
  if (!reader) {
    throw new ApiError('SSE 响应无 body', res.status, null)
  }

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const parsed = parseSseBlock(part)
      if (!parsed) continue
      onEvent({
        event: parsed.event as ChatSseEvent['event'],
        data: JSON.parse(parsed.data)
      } as ChatSseEvent)
    }
  }
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split('\n')
  let event = 'message'
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }

  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}
