export interface MessageAttachment {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  kind: 'image' | 'file'
  relativePath: string
  assetUrl: string
}

export interface ConversationMessageDto {
  id: string
  role: 'user' | 'assistant' | 'system' | string
  kind: 'text' | string
  content: string
  attachments: MessageAttachment[]
  coreCode: string
  sessionId?: string | null
  conversationId?: string | null
  runtimeSessionId?: string | null
  wizardPhase?: string | null

  thinking?: string | null

  thinkingDurationMs?: number | null
  payload?: unknown
  createdAt: string
}

export interface ConversationCoreDto {
  code: string
  label: string
  description: string
  available: boolean
  reason?: string | null
  detectedCommand?: string | null
  launchCommand?: string | null
  executablePath?: string | null
}

import type { TurnErrorDto } from './turn-errors'

export interface ConversationStateDto {
  configured: boolean
  agent: {
    name: string
    workspacePath: string
    coreCode: string
    createdAt?: string
    updatedAt?: string
  } | null
  sessionId?: string | null
  conversationId?: string | null
  runtimeSessionId?: string | null
  runtimeStatus?: string | null
  lastError?: TurnErrorDto | null
  lastUsedAt?: string | null
  pendingCount?: number
  core?: ConversationCoreDto | null
}
