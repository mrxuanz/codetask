import { api } from './client'
import type { ApiResponse } from './types'
import type { ExecutionTree } from './drafts'

export type JobProviderCode = 'codex' | 'claude-code' | 'opencode' | 'cursorcli'
export type JobState =
  | 'queued'
  | 'running'
  | 'pause_requested'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'deleted'
export type JobItemKind = 'work' | 'work_validation' | 'slice_validation' | 'milestone_validation'
export type JobItemState = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'

export interface JobRoleSettings {
  provider: JobProviderCode
  prompt: string
  skillsManual: string
}

export interface JobSettings {
  maxConcurrentJobs: 1 | 2
  work: JobRoleSettings
  workValidation: JobRoleSettings & { enabled: boolean }
  sliceValidation: JobRoleSettings & { enabled: boolean }
  milestoneValidation: JobRoleSettings & { enabled: boolean }
  revision: number
  updatedAtMs: number
}

export interface JobSettingsEnvelope {
  settings: JobSettings
  defaults: JobSettings
}

export interface JobProviderDescriptor {
  code: JobProviderCode
  label: string
  protocol: string
  supportsTask: boolean
  supportsVerification: boolean
}

export interface JobItemSnapshot {
  id: string
  sequence: number
  kind: JobItemKind
  treeTaskId: string | null
  scopeId: string
  parentItemId: string | null
  title: string
  objective: string
  files: string[]
  acceptanceCriteria: string[]
  attachmentIds: string[]
  state: JobItemState
  attempt: number
  repairGeneration: number
  provider: JobProviderCode
  result: {
    status: 'completed' | 'passed' | 'repair' | 'failed'
    summary: string
    changedFiles?: string[]
    evidence: string[]
  } | null
  error: { code: string; message: string } | null
  startedAtMs: number | null
  finishedAtMs: number | null
}

export interface JobSnapshot {
  id: string
  workspaceId: string
  title: string
  summary: string
  workspace: { id: string; title: string; rootPath: string }
  sourceDraft: {
    title: string
    objective: string
    requirements: string
    constraints: string
    acceptanceCriteria: string
  }
  executionTree: ExecutionTree
  attachments: Array<{
    id: string
    sourceAttachmentId: string
    displayName: string
    mediaType: string
    sizeBytes: number
  }>
  state: JobState
  revision: number
  queuePosition: number | null
  activeItemId: string | null
  completedItems: number
  totalItems: number
  lastError: { code: string; message: string } | null
  createdAtMs: number
  updatedAtMs: number
  startedAtMs: number | null
  finishedAtMs: number | null
  items: JobItemSnapshot[]
}

export interface JobEvent {
  id: number
  jobId: string | null
  eventType: string
  payload: Record<string, unknown>
  createdAtMs: number
}

export function fetchJobSettings(): Promise<ApiResponse<JobSettingsEnvelope>> {
  return api<JobSettingsEnvelope>('/api/job-settings')
}

export function updateJobSettings(
  settings: JobSettings,
  expectedRevision: number
): Promise<ApiResponse<JobSettingsEnvelope>> {
  return api<JobSettingsEnvelope>('/api/job-settings', {
    method: 'PUT',
    body: JSON.stringify({ settings, expectedRevision })
  })
}

export function fetchJobProviders(): Promise<ApiResponse<JobProviderDescriptor[]>> {
  return api<JobProviderDescriptor[]>('/api/job-providers')
}

export function fetchJobs(): Promise<ApiResponse<JobSnapshot[]>> {
  return api<JobSnapshot[]>('/api/jobs')
}

export function fetchJob(id: string): Promise<ApiResponse<JobSnapshot>> {
  return api<JobSnapshot>(`/api/jobs/${encodeURIComponent(id)}`)
}

export function pauseJob(id: string): Promise<ApiResponse<JobSnapshot>> {
  return api<JobSnapshot>(`/api/jobs/${encodeURIComponent(id)}/pause`, { method: 'POST' })
}

export function continueJob(id: string): Promise<ApiResponse<JobSnapshot>> {
  return api<JobSnapshot>(`/api/jobs/${encodeURIComponent(id)}/continue`, { method: 'POST' })
}

export function deleteJob(id: string): Promise<ApiResponse<{ deleted: true }>> {
  return api<{ deleted: true }>(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function subscribeJobEvents(
  onEvent: (event: JobEvent) => void,
  onConnectionError?: () => void
): () => void {
  const source = new EventSource('/api/job-events', { withCredentials: true })
  source.addEventListener('job', (raw) => {
    const event = raw as MessageEvent<string>
    const parsed = JSON.parse(event.data) as Omit<JobEvent, 'id'>
    const id = Number(event.lastEventId)
    onEvent({ ...parsed, id: Number.isSafeInteger(id) ? id : 0 })
  })
  source.onerror = () => onConnectionError?.()
  return () => source.close()
}
