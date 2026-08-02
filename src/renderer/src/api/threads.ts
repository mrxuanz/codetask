/**
 * Renderer thread API — compatibility façade over Conversation module (03).
 * Maps ConversationDto ↔ legacy Thread shape for existing UI.
 */
import type { ConversationDto } from '@codetask/contracts'
import {
  createConversation,
  deleteConversation,
  listConversations,
  listProjectConversations,
  renameConversation,
  switchConversationProvider,
  getConversation
} from './conversation'
import type { ApiResponse } from './types'
import type { ThreadDto } from '@shared/contracts/threads'

export type { ThreadDto as Thread } from '@shared/contracts/threads'

export interface CreateThreadInput {
  title?: string
  coreCode?: string
  /** Ignored — Conversation is always chat. */
  threadKind?: 'chat'
}

function toHostCore(code: string): string {
  if (code === 'claude') return 'claude-code'
  if (code === 'cursor') return 'cursorcli'
  return code
}

function toCanonicalProvider(code: string | undefined): string | undefined {
  if (!code) return undefined
  if (code === 'claude-code' || code === 'claude') return 'claude'
  if (code === 'cursorcli' || code === 'cursor') return 'cursor'
  if (code === 'opencode') return 'opencode'
  return 'codex'
}

function isoToSec(value: string | undefined | null): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function fail<T>(message: string, status = 410): ApiResponse<T> {
  return {
    success: false,
    data: null as T,
    status,
    message,
    extra: { code: 'conversation.moved' }
  }
}

export function conversationToThread(c: ConversationDto): ThreadDto {
  return {
    id: c.id,
    projectId: c.projectId,
    username: c.actorId,
    title: c.title,
    titleSource: c.titleSource,
    threadKind: 'chat',
    status: c.state,
    conversationId: c.id,
    coreCode: toHostCore(c.providerCode),
    runtimeStatus: 'idle',
    runtimeSessionId: null,
    lastError: null,
    lastUsedAt: isoToSec(c.lastUsedAt ?? null),
    createdAt: isoToSec(c.createdAt) ?? 0,
    updatedAt: isoToSec(c.updatedAt) ?? 0
  }
}

/** Structural guard for realtime conversation.changed payloads. */
export function threadFromConversationPayload(value: unknown): ThreadDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const c = value as Partial<ConversationDto>
  if (typeof c.id !== 'string' || typeof c.projectId !== 'string') return null
  if (typeof c.actorId !== 'string' || typeof c.title !== 'string') return null
  if (typeof c.providerCode !== 'string' || typeof c.state !== 'string') return null
  if (typeof c.createdAt !== 'string' || typeof c.updatedAt !== 'string') return null
  return conversationToThread(c as ConversationDto)
}

function mapResponse(res: ApiResponse<ConversationDto>): ApiResponse<ThreadDto> {
  if (!res.success) return res as unknown as ApiResponse<ThreadDto>
  return { ...res, data: conversationToThread(res.data) }
}

function mapList(res: ApiResponse<ConversationDto[]>): ApiResponse<ThreadDto[]> {
  if (!res.success) return res as unknown as ApiResponse<ThreadDto[]>
  return { ...res, data: res.data.map(conversationToThread) }
}

export function fetchThread(threadId: string): Promise<ApiResponse<ThreadDto>> {
  return getConversation(threadId).then(mapResponse)
}

export function fetchThreads(): Promise<ApiResponse<ThreadDto[]>> {
  return listConversations().then(mapList)
}

export function createThread(
  projectId: string,
  input: CreateThreadInput = {}
): Promise<ApiResponse<ThreadDto>> {
  return createConversation(projectId, {
    title: input.title,
    providerCode: toCanonicalProvider(input.coreCode)
  }).then(mapResponse)
}

export function renameThread(threadId: string, title: string): Promise<ApiResponse<ThreadDto>> {
  return renameConversation(threadId, title).then(mapResponse)
}

export function updateThreadCore(
  threadId: string,
  coreCode: string
): Promise<ApiResponse<ThreadDto>> {
  const providerCode = toCanonicalProvider(coreCode)
  if (!providerCode) {
    return Promise.resolve(fail(`Unknown provider: ${coreCode}`, 400))
  }
  return switchConversationProvider(threadId, providerCode).then(mapResponse)
}

export function deleteThread(threadId: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return deleteConversation(threadId)
}

export function fetchProjectThreads(projectId: string): Promise<ApiResponse<ThreadDto[]>> {
  return listProjectConversations(projectId).then(mapList)
}
