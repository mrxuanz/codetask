import type {
  ConversationDto,
  ConversationMessageDto,
  ConversationTurnDto,
  CreateTurnAcceptedDto,
  ProviderSummary
} from '@codetask/contracts'
import type { ConversationCoreDto, ConversationStateDto } from '@shared/contracts/conversation'
import { api } from './client'
import type { ApiResponse } from './types'

export type {
  ConversationDto,
  ConversationMessageDto,
  ConversationTurnDto,
  CreateTurnAcceptedDto,
  ProviderSummary
}

/** UI-facing aliases kept while chat surfaces still say “core / thread”. */
export type ConversationCore = ConversationCoreDto
export type ConversationMessage = ConversationMessageDto
export type ConversationState = ConversationStateDto

function toHostCore(code: string): string {
  if (code === 'claude') return 'claude-code'
  if (code === 'cursor') return 'cursorcli'
  return code
}

function providerToCore(provider: ProviderSummary): ConversationCoreDto {
  return {
    code: toHostCore(provider.code),
    label: provider.label,
    description: provider.description,
    available: provider.available,
    reason: provider.unavailableReason ?? null,
    detectedCommand: provider.installation?.command ?? null,
    launchCommand: provider.installation?.command ?? null,
    executablePath: provider.installation?.executablePath ?? null
  }
}

export function fetchConversationProviders(): Promise<ApiResponse<ProviderSummary[]>> {
  return api<ProviderSummary[]>('/api/conversations/providers')
}

/** Compatibility wrapper: UI still loads “cores”; server exposes providers. */
export async function fetchConversationCores(): Promise<
  ApiResponse<{ cores: ConversationCoreDto[] }>
> {
  const res = await fetchConversationProviders()
  if (!res.success) {
    return res as unknown as ApiResponse<{ cores: ConversationCoreDto[] }>
  }
  return { ...res, data: { cores: res.data.map(providerToCore) } }
}

export function listConversations(): Promise<ApiResponse<ConversationDto[]>> {
  return api<ConversationDto[]>('/api/conversations')
}

export function listProjectConversations(
  projectId: string
): Promise<ApiResponse<ConversationDto[]>> {
  return api<ConversationDto[]>(`/api/projects/${encodeURIComponent(projectId)}/conversations`)
}

export function createConversation(
  projectId: string,
  body?: { title?: string; providerCode?: string }
): Promise<ApiResponse<ConversationDto>> {
  return api<ConversationDto>(`/api/projects/${encodeURIComponent(projectId)}/conversations`, {
    method: 'POST',
    body: JSON.stringify(body ?? {})
  })
}

export function getConversation(
  conversationId: string
): Promise<ApiResponse<ConversationDto>> {
  return api<ConversationDto>(`/api/conversations/${encodeURIComponent(conversationId)}`)
}

/** Compatibility: map ConversationDto into the chat UI’s ConversationState shape. */
export async function fetchThreadConversationState(
  conversationId: string
): Promise<ApiResponse<ConversationStateDto>> {
  const res = await getConversation(conversationId)
  if (!res.success) {
    return res as unknown as ApiResponse<ConversationStateDto>
  }
  const conversation = res.data
  const coreCode = toHostCore(conversation.providerCode)
  return {
    ...res,
    data: {
      configured: true,
      agent: {
        name: coreCode,
        workspacePath: '',
        coreCode
      },
      conversationId: conversation.id,
      runtimeStatus: 'idle',
      lastError: null,
      lastUsedAt: conversation.lastUsedAt ?? null,
      core: {
        code: coreCode,
        label: coreCode,
        description: '',
        available: true
      }
    }
  }
}

export function renameConversation(
  conversationId: string,
  title: string
): Promise<ApiResponse<ConversationDto>> {
  return api<ConversationDto>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title })
  })
}

export function switchConversationProvider(
  conversationId: string,
  providerCode: string
): Promise<ApiResponse<ConversationDto>> {
  return api<ConversationDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/provider`,
    {
      method: 'PATCH',
      body: JSON.stringify({ providerCode })
    }
  )
}

export function deleteConversation(
  conversationId: string
): Promise<ApiResponse<{ deleted: boolean }>> {
  return api<{ deleted: boolean }>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE'
  })
}

export function fetchConversationMessages(
  conversationId: string,
  limit = 50
): Promise<ApiResponse<ConversationMessageDto[]>> {
  return api<ConversationMessageDto[]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`
  )
}

export function createConversationTurn(
  conversationId: string,
  message: string,
  options?: {
    attachmentIds?: string[]
    idempotencyKey?: string
    providerCode?: string
  }
): Promise<ApiResponse<CreateTurnAcceptedDto>> {
  const idempotencyKey = options?.idempotencyKey ?? crypto.randomUUID()
  return api<CreateTurnAcceptedDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/turns`,
    {
      method: 'POST',
      body: JSON.stringify({
        message,
        attachmentIds: options?.attachmentIds ?? [],
        idempotencyKey,
        providerCode: options?.providerCode
      })
    }
  )
}

export function fetchConversationTurn(
  conversationId: string,
  turnId: string
): Promise<ApiResponse<ConversationTurnDto>> {
  return api<ConversationTurnDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}`
  )
}

export function cancelConversationTurn(
  conversationId: string,
  turnId: string
): Promise<ApiResponse<ConversationTurnDto>> {
  return api<ConversationTurnDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/cancel`,
    { method: 'POST' }
  )
}
