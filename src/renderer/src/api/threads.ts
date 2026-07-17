import { api } from './client'
import type { ApiResponse } from './types'
import type { ThreadDto } from '@shared/contracts/threads'

export type { ThreadDto as Thread } from '@shared/contracts/threads'

export interface CreateThreadInput {
  title?: string
  coreCode?: string
  threadKind?: 'chat' | 'create_task' | 'task_snapshot'
}

export function fetchThreads(): Promise<ApiResponse<ThreadDto[]>> {
  return api<ThreadDto[]>('/api/threads')
}

export function createThread(
  projectId: string,
  input: CreateThreadInput = {}
): Promise<ApiResponse<ThreadDto>> {
  return api<ThreadDto>(`/api/projects/${projectId}/threads`, {
    method: 'POST',
    body: JSON.stringify(input)
  })
}

export function renameThread(threadId: string, title: string): Promise<ApiResponse<ThreadDto>> {
  return api<ThreadDto>(`/api/threads/${threadId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title })
  })
}

export function updateThreadContext(
  threadId: string,
  patch: { activeDraftId?: string | null; activePlanId?: string | null }
): Promise<ApiResponse<ThreadDto>> {
  return api<ThreadDto>(`/api/threads/${threadId}/context`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  })
}

export function rollbackWizardPhase(
  threadId: string,
  input: { to: 'collect' | 'draft_review'; reason: string }
): Promise<ApiResponse<ThreadDto>> {
  return api<ThreadDto>(`/api/threads/${threadId}/wizard/rollback`, {
    method: 'POST',
    body: JSON.stringify(input)
  })
}

export function updateThreadCore(
  threadId: string,
  coreCode: string
): Promise<ApiResponse<ThreadDto>> {
  return api<ThreadDto>(`/api/threads/${threadId}/core`, {
    method: 'PATCH',
    body: JSON.stringify({ coreCode })
  })
}

export function deleteThread(threadId: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return api<{ deleted: boolean }>(`/api/threads/${threadId}`, {
    method: 'DELETE'
  })
}

export function discardEmptyCreateTaskThread(
  threadId: string
): Promise<ApiResponse<{ discarded: boolean }>> {
  return api<{ discarded: boolean }>(`/api/threads/${threadId}/discard-if-empty`, {
    method: 'POST'
  })
}
