import { authHeaders } from '@renderer/auth/token'
import {
  handleUnauthorizedApiError,
  shouldClearSessionOnApiError
} from '@renderer/auth/sessionRedirect'
import { api, ApiError } from './client'
import type { ApiResponse } from './types'

export type DraftStatus = 'editing' | 'generating' | 'tree_ready' | 'submitted'
export interface DraftRecord {
  id: string
  userId: string
  workspaceId: string
  sourceThreadId: string | null
  title: string
  objective: string
  requirements: string
  constraints: string
  acceptanceCriteria: string
  status: DraftStatus
  revision: number
  activeTreeId: string | null
  submittedHandoffId: string | null
  createdAtMs: number
  updatedAtMs: number
  submittedAtMs: number | null
}
export interface DraftAttachment {
  id: string
  draftId: string
  displayName: string
  mediaType: string
  sizeBytes: number
  sha256: string
  storageRelativePath: string
  createdAtMs: number
}
export interface ExecutionTask {
  id: string
  title: string
  objective: string
  kind: string
  estimatedMinutes: number
  files: string[]
  dependsOn: string[]
  acceptanceCriteria: string[]
  attachmentIds: string[]
}
export interface ExecutionSlice {
  id: string
  title: string
  objective: string
  successCriteria: string
  dependsOn: string[]
  tasks: ExecutionTask[]
}
export interface ExecutionMilestone {
  id: string
  title: string
  objective: string
  successCriteria: string
  slices: ExecutionSlice[]
}
export interface ExecutionTree {
  schemaVersion: 1
  title: string
  summary: string
  milestones: ExecutionMilestone[]
}
export interface DraftExecutionTreeRecord {
  id: string
  draftId: string
  generationRunId: string
  treeRevision: number
  sourceDraftRevision: number
  schemaVersion: 1
  model: string | null
  createdAtMs: number
  tree: ExecutionTree
}
export interface JobIntakeHandoff {
  id: string
  sourceDraftId: string
  sourceTreeId: string
  sourceDraftRevision: number
  sourceTreeRevision: number
  state: 'pending' | 'accepted' | 'rejected'
  attachmentCount: number
  createdAtMs: number
  jobModuleImplemented: false
}
export interface DraftDetails {
  draft: DraftRecord
  attachments: DraftAttachment[]
  executionTree: DraftExecutionTreeRecord | null
  handoff: JobIntakeHandoff | null
}
export interface DraftSettings {
  provider: 'cursorcli'
  model: string | null
  plannerPrompt: { value: string; useDefault: boolean }
  skillsManual: { value: string; useDefault: boolean }
  defaults: { plannerPrompt: string; skillsManual: string }
  revision: number
  updatedAtMs: number
}
export interface DraftContentInput {
  workspaceId: string
  sourceThreadId?: string | null
  title: string
  objective: string
  requirements: string
  constraints: string
  acceptanceCriteria: string
}
export type DraftGenerationEvent =
  | { type: 'started'; runId: string }
  | { type: 'thinking'; content: string }
  | { type: 'progress'; receivedCharacters: number }
  | { type: 'completed'; treeId: string; treeRevision: number; tree: ExecutionTree }
  | { type: 'error'; status: number; message: string; data: unknown }

export function fetchDraftSettings(): Promise<ApiResponse<DraftSettings>> {
  return api<DraftSettings>('/api/draft-settings')
}
export function updateDraftSettings(input: {
  model: string | null
  plannerPrompt: string | null
  skillsManual: string | null
  expectedRevision: number
}): Promise<ApiResponse<DraftSettings>> {
  return api<DraftSettings>('/api/draft-settings', {
    method: 'PUT',
    body: JSON.stringify(input)
  })
}
export function fetchDrafts(workspaceId?: string): Promise<ApiResponse<DraftRecord[]>> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''
  return api<DraftRecord[]>(`/api/drafts${query}`)
}
export function fetchDraft(id: string): Promise<ApiResponse<DraftDetails>> {
  return api<DraftDetails>(`/api/drafts/${encodeURIComponent(id)}`)
}
export function createDraft(input: DraftContentInput): Promise<ApiResponse<DraftRecord>> {
  return api<DraftRecord>('/api/drafts', { method: 'POST', body: JSON.stringify(input) })
}
export function updateDraft(
  id: string,
  input: Omit<DraftContentInput, 'workspaceId' | 'sourceThreadId'> & {
    expectedRevision: number
  }
): Promise<ApiResponse<DraftRecord>> {
  return api<DraftRecord>(`/api/drafts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input)
  })
}
export function deleteDraft(id: string): Promise<ApiResponse<{ deleted: true }>> {
  return api<{ deleted: true }>(`/api/drafts/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
}
export function uploadDraftAttachment(
  draftId: string,
  file: File,
  expectedRevision: number
): Promise<ApiResponse<{ draft: DraftRecord; attachment: DraftAttachment }>> {
  const body = new FormData()
  body.set('file', file)
  body.set('expectedRevision', String(expectedRevision))
  return api(`/api/drafts/${encodeURIComponent(draftId)}/attachments`, {
    method: 'POST',
    body
  })
}
export function removeDraftAttachment(
  draftId: string,
  attachmentId: string,
  expectedRevision: number
): Promise<ApiResponse<{ draft: DraftRecord }>> {
  return api(
    `/api/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}?expectedRevision=${expectedRevision}`,
    { method: 'DELETE' }
  )
}
export function draftAttachmentUrl(draftId: string, attachmentId: string): string {
  return `/api/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`
}
export function confirmDraftExecutionTree(
  draftId: string,
  expectedRevision: number,
  treeId: string
): Promise<ApiResponse<JobIntakeHandoff>> {
  return api<JobIntakeHandoff>(`/api/drafts/${encodeURIComponent(draftId)}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ expectedRevision, treeId })
  })
}

export async function streamDraftGeneration(
  draftId: string,
  onEvent: (event: DraftGenerationEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`/api/drafts/${encodeURIComponent(draftId)}/generate`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: authHeaders(),
    signal
  })
  if (!response.ok || !response.body) {
    throw new ApiError(await response.text(), response.status, null)
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
      const event = JSON.parse(line) as DraftGenerationEvent
      if (event.type === 'error') {
        if (shouldClearSessionOnApiError(200, event.status, event.message, event.data)) {
          handleUnauthorizedApiError()
        }
        throw new ApiError(event.message, 200, event.data, event.message)
      }
      onEvent(event)
    }
    if (done) break
  }
}
