import { authHeaders } from '@renderer/auth/token'
import type {
  MessageAttachment,
  TaskProgressDto,
  ThreadDraftSummaryDto,
  FlatTaskPlan,
  ThreadJobDto,
  UserDraftListItemDto
} from '@shared/contracts'
import type { ConversationMessageDto } from '@shared/contracts/conversation'
import { api, ApiError } from './client'
import type { ApiResponse } from './types'

export type {
  JobSseEvent,
  MessageAttachment,
  PlanProgressDto as PlanProgress,
  TaskProgressDto as TaskProgress,
  TaskProgressDto,
  ThreadDraftSummaryDto as ThreadDraftSummary,
  ThreadJobDto as ThreadJob,
  FlatTaskPlan,
  SavedJobPlan as ThreadJobPlan,
  UserDraftListItemDto as UserDraftListItem
} from '@shared/contracts'

export type ThreadJobPlanTask = FlatTaskPlan

export type TaskProgressItem = TaskProgressDto['tasks'][number]

export async function uploadThreadAttachment(
  threadId: string,
  file: File
): Promise<MessageAttachment> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`/api/threads/${threadId}/attachments`, {
    method: 'POST',
    headers: authHeaders(),
    body: form
  })
  if (!res.ok) {
    const raw = await res.text()
    throw new ApiError(raw || 'upload failed', res.status, null)
  }
  const body = (await res.json()) as { data?: { attachment?: MessageAttachment } }
  if (!body.data?.attachment) {
    throw new ApiError('上传响应无效', res.status, body)
  }
  return body.data.attachment
}

export function fetchLatestThreadJob(
  threadId: string
): Promise<ApiResponse<{ job: ThreadJobDto | null }>> {
  return api<{ job: ThreadJobDto | null }>(`/api/threads/${threadId}/jobs/latest`)
}

export function fetchJobs(
  status = 'all',
  page = 1,
  limit = 50,
  q = ''
): Promise<ApiResponse<{ jobs: ThreadJobDto[]; total: number }>> {
  const params = new URLSearchParams({
    status,
    page: String(page),
    limit: String(limit)
  })
  if (q.trim()) params.set('q', q.trim())
  return api<{ jobs: ThreadJobDto[]; total: number }>(`/api/jobs?${params.toString()}`)
}

export function fetchUserDrafts(options?: {
  q?: string
  completion?: 'all' | 'incomplete' | 'complete'
}): Promise<ApiResponse<{ drafts: UserDraftListItemDto[] }>> {
  const params = new URLSearchParams()
  if (options?.q?.trim()) params.set('q', options.q.trim())
  if (options?.completion && options.completion !== 'all') {
    params.set('completion', options.completion)
  }
  const query = params.toString()
  return api<{ drafts: UserDraftListItemDto[] }>(`/api/drafts${query ? `?${query}` : ''}`)
}

export function deleteUserDraft(
  threadId: string,
  messageId: string
): Promise<ApiResponse<{ mode: 'removed' | 'archived'; keptJobId: string | null }>> {
  return api<{ mode: 'removed' | 'archived'; keptJobId: string | null }>(
    `/api/drafts/${encodeURIComponent(threadId)}/${encodeURIComponent(messageId)}`,
    { method: 'DELETE' }
  )
}

export function fetchJob(jobId: string): Promise<ApiResponse<{ job: ThreadJobDto }>> {
  return api<{ job: ThreadJobDto }>(`/api/jobs/${jobId}`)
}

export function pauseJob(jobId: string): Promise<ApiResponse<{ job: ThreadJobDto }>> {
  return api<{ job: ThreadJobDto }>(`/api/jobs/${jobId}/pause`, { method: 'POST' })
}

export function resumeJob(jobId: string): Promise<ApiResponse<{ job: ThreadJobDto }>> {
  return api<{ job: ThreadJobDto }>(`/api/jobs/${jobId}/resume`, { method: 'POST' })
}

export function continueJob(jobId: string): Promise<ApiResponse<{ job: ThreadJobDto }>> {
  return api<{ job: ThreadJobDto }>(`/api/jobs/${jobId}/continue`, { method: 'POST' })
}

export function restartJob(jobId: string): Promise<ApiResponse<{ job: ThreadJobDto }>> {
  return api<{ job: ThreadJobDto }>(`/api/jobs/${jobId}/restart`, { method: 'POST' })
}

export function retryJobPlanning(jobId: string): Promise<ApiResponse<{ job: ThreadJobDto }>> {
  return api<{ job: ThreadJobDto }>(`/api/jobs/${jobId}/retry-planning`, { method: 'POST' })
}

export function deleteJob(jobId: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return api<{ deleted: boolean }>(`/api/jobs/${jobId}`, { method: 'DELETE' })
}

export function fetchTaskEvidenceDetail(
  threadId: string,
  jobId: string,
  taskId: string
): Promise<ApiResponse<{ evidence: import('@shared/contracts/evidence').TaskEvidenceDto }>> {
  return api<{ evidence: import('@shared/contracts/evidence').TaskEvidenceDto }>(
    `/api/threads/${threadId}/jobs/${jobId}/tasks/${taskId}/evidence`
  )
}

export function confirmDraftMessage(
  threadId: string,
  messageId: string
): Promise<ApiResponse<{ messageId: string; payload: Record<string, unknown> }>> {
  return api<{ messageId: string; payload: Record<string, unknown> }>(
    `/api/threads/${threadId}/messages/${messageId}/draft/confirm`,
    { method: 'POST' }
  )
}
export function confirmDraftSection(
  threadId: string,
  messageId: string,
  section: string
): Promise<ApiResponse<{ messageId: string; payload: Record<string, unknown> }>> {
  return api<{ messageId: string; payload: Record<string, unknown> }>(
    `/api/threads/${threadId}/messages/${messageId}/draft/sections/${section}/confirm`,
    { method: 'POST' }
  )
}

export function fetchThreadDrafts(
  threadId: string
): Promise<ApiResponse<{ drafts: ThreadDraftSummaryDto[] }>> {
  return api<{ drafts: ThreadDraftSummaryDto[] }>(`/api/threads/${threadId}/drafts`)
}

export function fetchThreadPlans(
  threadId: string
): Promise<ApiResponse<{ plans: ThreadJobDto[] }>> {
  return api<{ plans: ThreadJobDto[] }>(`/api/threads/${threadId}/plans`)
}

export function confirmExecutionPlan(
  threadId: string,
  jobId: string
): Promise<ApiResponse<{ job: ThreadJobDto }>> {
  return api<{ job: ThreadJobDto }>(`/api/threads/${threadId}/jobs/${jobId}/confirm-plan`, {
    method: 'POST'
  })
}

export function launchDesignSession(
  threadId: string,
  designSessionId: string
): Promise<ApiResponse<{ job: ThreadJobDto }>> {
  return api<{ job: ThreadJobDto }>(
    `/api/threads/${threadId}/design-sessions/${designSessionId}/launch`,
    { method: 'POST' }
  )
}

export function freezeReferenceCorpus(
  threadId: string,
  designSessionId: string
): Promise<ApiResponse<{ manifest: import('@shared/job-references').JobReferenceManifestDto }>> {
  return api<{ manifest: import('@shared/job-references').JobReferenceManifestDto }>(
    `/api/threads/${threadId}/design-sessions/${designSessionId}/references/freeze`,
    { method: 'POST' }
  )
}

export function updateJobPlanNode(
  threadId: string,
  jobId: string,
  patch: {
    nodeRef: string
    expectedPlanRevision?: number
    title?: string
    description?: string
    successCriteria?: string
    contextMarkdown?: string
    abilityCode?: string
    coreCode?: string
    referenceIds?: string[]
    referenceReason?: string
  }
): Promise<ApiResponse<{ job: ThreadJobDto }>> {
  return api<{ job: ThreadJobDto }>(`/api/threads/${threadId}/jobs/${jobId}/plan`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  })
}

export function confirmPlanNode(
  threadId: string,
  jobId: string,
  nodeRef: string
): Promise<ApiResponse<{ job: ThreadJobDto }>> {
  return api<{ job: ThreadJobDto }>(
    `/api/threads/${threadId}/jobs/${jobId}/plan/nodes/${encodeURIComponent(nodeRef)}/confirm`,
    { method: 'POST' }
  )
}

export function updateDraftContent(
  threadId: string,
  messageId: string,
  patch: {
    title?: string
    summary?: string
    userFlow?: string
    techStack?: string
    requirementsContractMarkdown?: string
  }
): Promise<ApiResponse<{ messageId: string; payload: Record<string, unknown> }>> {
  return api<{ messageId: string; payload: Record<string, unknown> }>(
    `/api/threads/${threadId}/messages/${messageId}/draft`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch)
    }
  )
}

export function updateDraftAbilityCores(
  threadId: string,
  messageId: string,
  selections: Array<{ abilityCode: string; coreCode: string }>
): Promise<ApiResponse<{ messageId: string; payload: Record<string, unknown> }>> {
  return api<{ messageId: string; payload: Record<string, unknown> }>(
    `/api/threads/${threadId}/messages/${messageId}/draft/abilities`,
    {
      method: 'PATCH',
      body: JSON.stringify({ selections })
    }
  )
}

export function unlockDraftForEdit(
  threadId: string,
  draftMessageId: string
): Promise<
  ApiResponse<{ draft: ConversationMessageDto; thread: { id: string; wizardPhase: string } }>
> {
  return api<{ draft: ConversationMessageDto; thread: { id: string; wizardPhase: string } }>(
    `/api/threads/${threadId}/messages/${draftMessageId}/draft/unlock`,
    { method: 'POST' }
  )
}

export function unlockRequirementsContract(
  threadId: string,
  draftMessageId: string
): Promise<
  ApiResponse<{
    messageId: string
    payload: Record<string, unknown>
    message: ConversationMessageDto
  }>
> {
  return api<{
    messageId: string
    payload: Record<string, unknown>
    message: ConversationMessageDto
  }>(`/api/threads/${threadId}/messages/${draftMessageId}/draft/unlock-contract`, {
    method: 'POST'
  })
}

export function launchJobFromDraft(
  threadId: string,
  draftMessageId: string
): Promise<
  ApiResponse<{ job: ThreadJobDto; draft: import('./conversation').ConversationMessage }>
> {
  return api<{ job: ThreadJobDto; draft: import('./conversation').ConversationMessage }>(
    `/api/threads/${threadId}/jobs`,
    {
      method: 'POST',
      body: JSON.stringify({ draftMessageId })
    }
  )
}

export async function uploadDraftReferences(
  threadId: string,
  messageId: string,
  files: File[]
): Promise<{ messageId: string; payload: Record<string, unknown> }> {
  const form = new FormData()
  for (const file of files) {
    form.append('file', file)
  }
  const res = await fetch(`/api/threads/${threadId}/messages/${messageId}/draft/references`, {
    method: 'POST',
    headers: authHeaders(),
    body: form
  })
  if (!res.ok) {
    const raw = await res.text()
    throw new ApiError(raw || 'upload failed', res.status, null)
  }
  const body = (await res.json()) as {
    data?: { messageId: string; payload: Record<string, unknown> }
  }
  if (!body.data) throw new ApiError('上传响应无效', res.status, body)
  return body.data
}

export function deleteDraftReference(
  threadId: string,
  messageId: string,
  referenceId: string
): Promise<ApiResponse<{ messageId: string; payload: Record<string, unknown> }>> {
  return api<{ messageId: string; payload: Record<string, unknown> }>(
    `/api/threads/${threadId}/messages/${messageId}/draft/references/${referenceId}`,
    { method: 'DELETE' }
  )
}

export function updateDraftReferenceDescription(
  threadId: string,
  messageId: string,
  referenceId: string,
  description: string
): Promise<ApiResponse<{ messageId: string; payload: Record<string, unknown> }>> {
  return api<{ messageId: string; payload: Record<string, unknown> }>(
    `/api/threads/${threadId}/messages/${messageId}/draft/references/${referenceId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ description })
    }
  )
}

export function importDraftReferences(
  threadId: string,
  messageId: string,
  attachmentIds: string[],
  descriptions: Record<string, string> = {}
): Promise<ApiResponse<{ messageId: string; payload: Record<string, unknown> }>> {
  return api<{ messageId: string; payload: Record<string, unknown> }>(
    `/api/threads/${threadId}/messages/${messageId}/draft/references/import`,
    {
      method: 'POST',
      body: JSON.stringify({ attachmentIds, descriptions })
    }
  )
}

export function addLocalCorpusDraftReference(
  threadId: string,
  messageId: string,
  input: {
    localPath: string
    name: string
    description: string
    kind?: 'file' | 'directory'
  }
): Promise<ApiResponse<{ messageId: string; payload: Record<string, unknown> }>> {
  return api<{ messageId: string; payload: Record<string, unknown> }>(
    `/api/threads/${threadId}/messages/${messageId}/draft/references/local-corpus`,
    {
      method: 'POST',
      body: JSON.stringify(input)
    }
  )
}
