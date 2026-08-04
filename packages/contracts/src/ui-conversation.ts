import type { ProviderCode } from './execution.ts'

/** Uploaded / draft attachment as shown in chat and create-task UI. */
export type MessageAttachment = {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  kind: 'image' | 'file'
  relativePath: string
  assetUrl: string
}

/**
 * Chat bubble shape for renderer lists.
 * Wire ConversationMessageDto from conversation.ts remains the HTTP contract;
 * map via toUiConversationMessage in the client.
 */
export type UiConversationMessage = {
  id: string
  role: 'user' | 'assistant' | 'system' | string
  kind: 'text' | string
  content: string
  attachments: MessageAttachment[]
  /** Canonical provider code when known. */
  providerCode: string
  conversationId?: string | null
  thinking?: string | null
  thinkingDurationMs?: number | null
  createdAt: string
}

/** Provider option for chat picker — canonical codes only. */
export type ProviderOptionDto = {
  code: ProviderCode | string
  label: string
  description: string
  available: boolean
  readOnlyCapable?: boolean | undefined
  reason?: string | null | undefined
  detectedCommand?: string | null | undefined
  launchCommand?: string | null | undefined
  executablePath?: string | null | undefined
}

/** @deprecated Use ProviderOptionDto — historical “core” naming. */
export type ConversationCoreDto = ProviderOptionDto

export type ConversationRuntimeStateDto = {
  configured: boolean
  agent: {
    name: string
    workspacePath: string
    providerCode: string
    createdAt?: string
    updatedAt?: string
  } | null
  conversationId?: string | null
  runtimeStatus?: string | null
  lastError?: { code: string; message: string } | null
  lastUsedAt?: string | null
  pendingCount?: number
  provider?: ProviderOptionDto | null
}

/** @deprecated Use ConversationRuntimeStateDto */
export type ConversationStateDto = ConversationRuntimeStateDto
