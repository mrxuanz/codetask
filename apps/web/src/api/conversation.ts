import type {
  ConversationDto,
  ConversationMessageDto as ContractConversationMessageDto,
  ConversationTurnDto,
  CreateTurnAcceptedDto,
  ProviderSummary,
  MessageAttachment,
  UiConversationMessage,
  ProviderOptionDto,
  ConversationRuntimeStateDto,
  ConversationListItemDto
} from '@codetask/contracts'
import { api, ApiError } from './client'
import type { ApiSuccess } from './types'

export type {
  ConversationDto,
  ConversationTurnDto,
  CreateTurnAcceptedDto,
  ProviderSummary,
  MessageAttachment,
  UiConversationMessage,
  ProviderOptionDto,
  ConversationListItemDto
}

/** UI-facing aliases while some surfaces still say “core”. */
export type ConversationCore = ProviderOptionDto
export type ConversationMessage = UiConversationMessage
export type ConversationState = ConversationRuntimeStateDto

/** Map wire message DTO → chat UI message (attachments + canonical providerCode). */
export function toUiConversationMessage(
  message: ContractConversationMessageDto
): UiConversationMessage {
  const conversationId = message.conversationId
  const attachments: MessageAttachment[] = (message.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    relativePath: '',
    assetUrl: `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachment.id)}`
  }))
  return {
    id: message.id,
    role: message.role,
    kind: message.kind,
    content: message.content,
    attachments,
    providerCode: message.providerCode ?? '',
    conversationId,
    thinking: message.thinking ?? null,
    thinkingDurationMs: message.thinkingDurationMs ?? null,
    createdAt: message.createdAt
  }
}

function providerToOption(provider: ProviderSummary): ProviderOptionDto {
  return {
    code: provider.code,
    label: provider.label,
    description: provider.description,
    available: provider.available,
    reason: provider.unavailableReason ?? null,
    detectedCommand: provider.installation?.command ?? null,
    launchCommand: provider.installation?.command ?? null,
    executablePath: provider.installation?.executablePath ?? null
  }
}

export function fetchConversationProviders(): Promise<ApiSuccess<ProviderSummary[]>> {
  return api<ProviderSummary[]>('/api/conversations/providers')
}

/** Compatibility wrapper: UI still loads “cores”; server exposes providers. */
export async function fetchConversationProviderOptions(): Promise<
  ApiSuccess<{ cores: ProviderOptionDto[] }>
> {
  const res = await fetchConversationProviders()
  return { ...res, data: { cores: res.data.map(providerToOption) } }
}

export function listConversations(): Promise<ApiSuccess<ConversationDto[]>> {
  return api<ConversationDto[]>('/api/conversations')
}

export function listProjectConversations(
  projectId: string
): Promise<ApiSuccess<ConversationDto[]>> {
  return api<ConversationDto[]>(`/api/projects/${encodeURIComponent(projectId)}/conversations`)
}

export function createConversation(
  projectId: string,
  body?: { title?: string; providerCode?: string }
): Promise<ApiSuccess<ConversationDto>> {
  return api<ConversationDto>(`/api/projects/${encodeURIComponent(projectId)}/conversations`, {
    method: 'POST',
    body: JSON.stringify(body ?? {})
  })
}

export function getConversation(conversationId: string): Promise<ApiSuccess<ConversationDto>> {
  return api<ConversationDto>(`/api/conversations/${encodeURIComponent(conversationId)}`)
}

/** Compatibility: map ConversationDto into the chat UI runtime state shape. */
export async function fetchThreadConversationState(
  conversationId: string
): Promise<ApiSuccess<ConversationRuntimeStateDto>> {
  const res = await getConversation(conversationId)
  const conversation = res.data
  const providerCode = conversation.providerCode
  return {
    ...res,
    data: {
      configured: true,
      agent: {
        name: providerCode,
        workspacePath: '',
        providerCode
      },
      conversationId: conversation.id,
      runtimeStatus: 'idle',
      lastError: null,
      lastUsedAt: conversation.lastUsedAt ?? null,
      provider: {
        code: providerCode,
        label: providerCode,
        description: '',
        available: true
      }
    }
  }
}

export function renameConversation(
  conversationId: string,
  title: string
): Promise<ApiSuccess<ConversationDto>> {
  return api<ConversationDto>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title })
  })
}

export function switchConversationProvider(
  conversationId: string,
  providerCode: string
): Promise<ApiSuccess<ConversationDto>> {
  return api<ConversationDto>(`/api/conversations/${encodeURIComponent(conversationId)}/provider`, {
    method: 'PATCH',
    body: JSON.stringify({ providerCode })
  })
}

export function deleteConversation(
  conversationId: string
): Promise<ApiSuccess<{ deleted: boolean }>> {
  return api<{ deleted: boolean }>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE'
  })
}

export async function fetchConversationMessages(
  conversationId: string,
  limit = 50
): Promise<ApiSuccess<UiConversationMessage[]>> {
  const res = await api<ContractConversationMessageDto[]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`
  )
  return {
    ...res,
    data: res.data.map(toUiConversationMessage)
  }
}

export function createConversationTurn(
  conversationId: string,
  message: string,
  options?: {
    attachmentIds?: string[]
    idempotencyKey?: string
    providerCode?: string
  }
): Promise<ApiSuccess<CreateTurnAcceptedDto>> {
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
): Promise<ApiSuccess<ConversationTurnDto>> {
  return api<ConversationTurnDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}`
  )
}

export function cancelConversationTurn(
  conversationId: string,
  turnId: string
): Promise<ApiSuccess<ConversationTurnDto>> {
  return api<ConversationTurnDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/cancel`,
    { method: 'POST' }
  )
}

function toCanonicalProvider(code: string | undefined): string | undefined {
  if (!code) return undefined
  const normalized = code.trim().toLowerCase()
  if (normalized === 'claude' || normalized === 'claude-code' || normalized === 'claude_code') {
    return 'claude'
  }
  if (
    normalized === 'cursor' ||
    normalized === 'cursorcli' ||
    normalized === 'cursor-cli' ||
    normalized === 'cursor-agent' ||
    normalized === 'cursor_cli'
  ) {
    return 'cursor'
  }
  if (normalized === 'opencode') return 'opencode'
  if (normalized === 'codex') return 'codex'
  return undefined
}

function isoToSec(value: string | undefined | null): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** Map ConversationDto → sidebar list row (no Thread façade). */
export function conversationToListItem(c: ConversationDto): ConversationListItemDto {
  return {
    id: c.id,
    projectId: c.projectId,
    actorId: c.actorId,
    title: c.title,
    titleSource: c.titleSource,
    status: c.state,
    conversationId: c.id,
    providerCode: c.providerCode,
    runtimeStatus: 'idle',
    runtimeSessionId: null,
    lastError: null,
    lastUsedAt: isoToSec(c.lastUsedAt ?? null),
    createdAt: isoToSec(c.createdAt) ?? 0,
    updatedAt: isoToSec(c.updatedAt) ?? 0
  }
}

export function conversationFromRealtimePayload(value: unknown): ConversationListItemDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const c = value as Partial<ConversationDto>
  if (typeof c.id !== 'string' || typeof c.projectId !== 'string') return null
  if (typeof c.actorId !== 'string' || typeof c.title !== 'string') return null
  if (typeof c.providerCode !== 'string' || typeof c.state !== 'string') return null
  if (typeof c.createdAt !== 'string' || typeof c.updatedAt !== 'string') return null
  return conversationToListItem(c as ConversationDto)
}

export async function listConversationItems(): Promise<ApiSuccess<ConversationListItemDto[]>> {
  const res = await listConversations()
  return { ...res, data: res.data.map(conversationToListItem) }
}

export async function createConversationItem(
  projectId: string,
  input: { title?: string; providerCode?: string } = {}
): Promise<ApiSuccess<ConversationListItemDto>> {
  const res = await createConversation(projectId, {
    title: input.title,
    providerCode: toCanonicalProvider(input.providerCode)
  })
  return { ...res, data: conversationToListItem(res.data) }
}

export async function renameConversationItem(
  conversationId: string,
  title: string
): Promise<ApiSuccess<ConversationListItemDto>> {
  const res = await renameConversation(conversationId, title)
  return { ...res, data: conversationToListItem(res.data) }
}

export async function updateConversationProviderCode(
  conversationId: string,
  providerCode: string
): Promise<ApiSuccess<ConversationListItemDto>> {
  const canonical = toCanonicalProvider(providerCode)
  if (!canonical) {
    throw new ApiError(`Unknown provider: ${providerCode}`, 400, null, 'provider.unknown')
  }
  const res = await switchConversationProvider(conversationId, canonical)
  return { ...res, data: conversationToListItem(res.data) }
}
