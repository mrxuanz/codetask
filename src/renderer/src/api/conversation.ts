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
import { parseSseBlock, readSseWithTimeout } from '@shared/sse'

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
    signal?: AbortSignal
  }
): Promise<void> {
  const signal = options?.signal
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }

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
    }),
    signal
  })

  await throwIfNotSseResponse(res)

  const reader = res.body?.getReader()
  if (!reader) {
    throw new ApiError('SSE 响应无 body', res.status, null)
  }

  const cancelReader = (): void => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', cancelReader, { once: true })

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted) break
      const { done, value } = await readSseWithTimeout(reader)
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        if (signal?.aborted) break
        const parsed = parseSseBlock(part)
        if (!parsed) continue
        onEvent({
          event: parsed.event as ChatSseEvent['event'],
          data: JSON.parse(parsed.data)
        } as ChatSseEvent)
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader)
  }

  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }
}

