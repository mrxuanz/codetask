import { authHeaders } from '@renderer/auth/token'
import {
  handleUnauthorizedApiError,
  shouldClearSessionOnApiError
} from '@renderer/auth/sessionRedirect'
import { api, ApiError } from './client'
import type { ApiResponse } from './types'

export interface ConversationSettings {
  userId: string
  provider: 'cursorcli'
  model: string | null
  revision: number
  updatedAtMs: number
}

export interface ConversationProviderStatus {
  code: 'cursorcli'
  label: 'Cursor CLI'
  installed: boolean
  authenticated: boolean
  authMode: 'host-login'
  loginCommand: 'agent login'
  statusCommand: 'agent status'
  message: string
}

export interface ConversationWorkspace {
  id: string
  userId: string
  title: string
  rootPath: string
  canonicalKey: string
  workspaceAccess: 'read-only' | 'write'
  createdAtMs: number
  updatedAtMs: number
}

export interface ConversationThread {
  id: string
  workspaceId: string
  title: string
  provider: 'cursorcli'
  model: string | null
  runtimeSessionId: string | null
  createdAtMs: number
  updatedAtMs: number
  lastMessageAtMs: number | null
}

export interface ConversationMessage {
  id: string
  threadId: string
  role: 'user' | 'assistant'
  content: string
  sequence: number
  createdAtMs: number
}

export type ConversationStreamEvent =
  | { type: 'started'; turnId: string; workspaceAccess: 'read-only' | 'write' }
  | { type: 'delta'; content: string }
  | { type: 'thinking'; content: string }
  | {
      type: 'completed'
      messageId: string
      reply: string
      runtimeSessionId: string | null
    }
  | { type: 'error'; status: number; message: string; data: unknown }

export function fetchConversationSettings(): Promise<ApiResponse<ConversationSettings>> {
  return api<ConversationSettings>('/api/conversation/settings')
}

export function updateConversationSettings(
  model: string | null
): Promise<ApiResponse<ConversationSettings>> {
  return api<ConversationSettings>('/api/conversation/settings', {
    method: 'PUT',
    body: JSON.stringify({ model })
  })
}

export function fetchConversationProviderStatus(): Promise<
  ApiResponse<ConversationProviderStatus>
> {
  return api<ConversationProviderStatus>('/api/conversation/provider-status')
}

export function fetchConversationWorkspaces(): Promise<ApiResponse<ConversationWorkspace[]>> {
  return api<ConversationWorkspace[]>('/api/conversation/workspaces')
}

export function createConversationWorkspace(
  path: string
): Promise<ApiResponse<ConversationWorkspace>> {
  return api<ConversationWorkspace>('/api/conversation/workspaces', {
    method: 'POST',
    body: JSON.stringify({ path })
  })
}

export function deleteConversationWorkspace(id: string): Promise<ApiResponse<{ deleted: true }>> {
  return api<{ deleted: true }>(`/api/conversation/workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
}

export function fetchConversationThreads(
  workspaceId: string
): Promise<ApiResponse<ConversationThread[]>> {
  return api<ConversationThread[]>(
    `/api/conversation/workspaces/${encodeURIComponent(workspaceId)}/threads`
  )
}

export function createConversationThread(
  workspaceId: string
): Promise<ApiResponse<ConversationThread>> {
  return api<ConversationThread>(
    `/api/conversation/workspaces/${encodeURIComponent(workspaceId)}/threads`,
    {
      method: 'POST',
      body: JSON.stringify({})
    }
  )
}

export function deleteConversationThread(id: string): Promise<ApiResponse<{ deleted: true }>> {
  return api<{ deleted: true }>(`/api/conversation/threads/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
}

export function fetchConversationMessages(
  threadId: string
): Promise<ApiResponse<ConversationMessage[]>> {
  return api<ConversationMessage[]>(
    `/api/conversation/threads/${encodeURIComponent(threadId)}/messages`
  )
}

export async function streamConversationTurn(
  threadId: string,
  prompt: string,
  onEvent: (event: ConversationStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const headers = new Headers(authHeaders())
  headers.set('Content-Type', 'application/json')
  const response = await fetch(`/api/conversation/threads/${encodeURIComponent(threadId)}/turns`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({ prompt }),
    signal
  })

  if (!response.ok || !response.body) {
    const raw = await response.text()
    let data: unknown = { raw }
    let message = raw || `request failed with HTTP ${response.status}`
    let status = response.status
    try {
      const parsed = JSON.parse(raw) as {
        status?: number
        message?: string
        data?: unknown
      }
      data = parsed.data
      message = parsed.message ?? message
      status = parsed.status ?? status
    } catch {
      // Preserve the transport text.
    }
    if (shouldClearSessionOnApiError(response.status, status, message, data)) {
      handleUnauthorizedApiError()
    }
    throw new ApiError(message, response.status, data, message)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  while (true) {
    const { done, value } = await reader.read()
    pending += decoder.decode(value, { stream: !done })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as ConversationStreamEvent
      if (event.type === 'error') {
        throw new ApiError(event.message, 200, event.data, event.message)
      }
      onEvent(event)
    }
    if (done) break
  }
  if (pending.trim()) {
    const event = JSON.parse(pending) as ConversationStreamEvent
    if (event.type === 'error') {
      throw new ApiError(event.message, 200, event.data, event.message)
    }
    onEvent(event)
  }
}
