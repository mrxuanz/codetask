import { authHeaders } from '@renderer/auth/token'
import type {
  MessageAttachment,
  TaskProgressDto,
  ThreadDraftSummaryDto,
  FlatTaskPlan,
  UserDraftListItemDto
} from '@shared/contracts'
import type { PlanningSessionViewDto } from '@shared/contracts/planning-session-view'
import { toPlanningSessionStatus } from '@shared/contracts/planning-session-view'
import { designDraftToPayload, type TaskLaunchDraftPayload } from '@renderer/lib/draftForm'
import { api, ApiError } from './client'
import type { ApiResponse } from './types'
import {
  addDesignDraftReference,
  confirmDesignDraft,
  confirmPlanningTreeNode,
  deleteDesignDraftReference,
  getDesignDraft,
  getPlanningSession,
  listDesignDrafts,
  listPlanningSessionsForDraft,
  patchDesignAbilities,
  patchDesignDraftReference,
  patchDesignExecutionProfile,
  patchPlanningTreeNode,
  publishPlanningSession,
  startPlanningSession,
  unlockDesignDraft,
  type DesignDraftDto
} from './design'
import {
  newIdempotencyKey,
  resolveJobsApi,
  type ExecutionJob
} from './jobs-api'

export type { ExecutionJob }
export type { PlanningSessionViewDto } from '@shared/contracts/planning-session-view'
export { toPlanningSessionStatus } from '@shared/contracts/planning-session-view'

/** Map an Execution job into the plan-review list shape (no fake runtime fields). */
export function mapExecutionJobToPlanView(job: ExecutionJob): PlanningSessionViewDto {
  const status =
    job.status === 'succeeded'
      ? 'completed'
      : job.status === 'queued'
        ? 'pending'
        : job.status === 'cancelling'
          ? 'cancelled'
          : toPlanningSessionStatus(job.status)
  return {
    id: job.id,
    threadId: '',
    draftMessageId: job.sourceDraftId || '',
    title: job.title,
    summary: job.summary ?? '',
    status,
    abilities: [],
    workspacePath: job.workspaceRoot,
    planProgress: {
      phase: status === 'failed' ? 'failed' : 'plan_ready',
      status: status === 'failed' ? 'failed' : 'completed',
      contextsRegistered: 0,
      contextsTotal: 0
    },
    taskProgress: {
      phase: status === 'running' || status === 'pausing' ? 'running' : 'idle',
      status:
        status === 'running' || status === 'pausing'
          ? 'running'
          : status === 'failed'
            ? 'failed'
            : status === 'completed'
              ? 'completed'
              : 'pending',
      currentIndex: 0,
      total: 0,
      tasks: []
    },
    queue:
      job.queuePosition != null
        ? { position: job.queuePosition, ahead: Math.max(0, job.queuePosition - 1) }
        : undefined,
    designSessionId: job.sourcePlanningSessionId || null,
    stateRevision: job.stateRevision,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  }
}

export type {
  MessageAttachment,
  PlanProgressDto as PlanProgress,
  TaskProgressDto as TaskProgress,
  TaskProgressDto,
  ThreadDraftSummaryDto as ThreadDraftSummary,
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
  const res = await fetch(`/api/conversations/${threadId}/attachments`, {
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

export async function fetchLatestThreadJob(
  threadId: string
): Promise<ApiResponse<{ job: PlanningSessionViewDto | null }>> {
  const plansRes = await fetchThreadPlans(threadId)
  const job =
    [...plansRes.data.plans].sort((a, b) => {
      const aAt = Date.parse(String(a.updatedAt ?? a.createdAt ?? 0))
      const bAt = Date.parse(String(b.updatedAt ?? b.createdAt ?? 0))
      return bAt - aAt
    })[0] ?? null
  return { ...plansRes, data: { job } }
}

export function fetchJobs(
  status = 'all',
  page = 1,
  limit = 50,
  q = ''
): Promise<ApiResponse<{ jobs: ExecutionJob[]; total: number }>> {
  return resolveJobsApi().fetchJobs(status, page, limit, q)
}

export function fetchJob(jobId: string): Promise<ApiResponse<{ job: ExecutionJob }>> {
  return resolveJobsApi().fetchJob(jobId)
}

function commandBody(expectedRevision: number, idempotencyKey: string): string {
  return JSON.stringify({ expectedRevision, idempotencyKey })
}

export function pauseJob(
  jobId: string,
  expectedRevision = 0,
  idempotencyKey = newIdempotencyKey()
): Promise<ApiResponse<{ job: ExecutionJob }>> {
  return resolveJobsApi().pause(jobId, expectedRevision, idempotencyKey)
}

export function continueJob(
  jobId: string,
  expectedRevision = 0,
  idempotencyKey = newIdempotencyKey(),
  authorizeReplay?: boolean
): Promise<ApiResponse<{ job: ExecutionJob }>> {
  return resolveJobsApi().continue(jobId, expectedRevision, idempotencyKey, authorizeReplay)
}

export function restartJob(
  jobId: string,
  expectedRevision = 0,
  idempotencyKey = newIdempotencyKey()
): Promise<ApiResponse<{ job: ExecutionJob }>> {
  return resolveJobsApi().restartExecution(jobId, expectedRevision, idempotencyKey)
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
  return api<DesignDraftDto[] | { drafts: UserDraftListItemDto[] }>(
    `/api/drafts${query ? `?${query}` : ''}`
  ).then((res) => {
    const raw = res.data
    if (Array.isArray(raw)) {
      const drafts: UserDraftListItemDto[] = raw.map((d) => ({
        messageId: d.id,
        draftId: d.id,
        title: d.title,
        summary: d.summary,
        status: d.status,
        linkedPlanId: null,
        createdAt: new Date(d.createdAt).toISOString(),
        plan: null,
        threadId: '',
        projectId: d.projectId,
        projectTitle: '',
        threadTitle: d.title,
        launched: false,
        jobId: null
      }))
      return { ...res, data: { drafts } }
    }
    return res as ApiResponse<{ drafts: UserDraftListItemDto[] }>
  })
}

export function deleteUserDraft(
  draftId: string,
  _messageId?: string
): Promise<ApiResponse<{ mode: 'removed' | 'archived'; keptJobId: string | null }>> {
  return api<{ archived: boolean }>(`/api/drafts/${encodeURIComponent(draftId)}`, {
    method: 'DELETE'
  }).then((res) => ({
    ...res,
    data: { mode: 'archived' as const, keptJobId: null }
  }))
}

export function retryJobPlanning(sessionId: string): Promise<ApiResponse<{ job: PlanningSessionViewDto }>> {
  return api<unknown>(`/api/planning-sessions/${encodeURIComponent(sessionId)}/retry`, {
    method: 'POST',
    body: '{}'
  }).then(async () => {
    const current = await getPlanningSession(sessionId)
    return {
      success: true as const,
      status: 0,
      message: 'success',
      extra: {},
      data: { job: mapPlanningSessionToJob(current.data.session) }
    }
  })
}

export function deleteJob(
  jobId: string,
  expectedRevision = 0,
  idempotencyKey = newIdempotencyKey()
): Promise<ApiResponse<{ deleted: boolean }>> {
  return api<{ deleted: boolean }>(`/api/jobs/${jobId}`, {
    method: 'DELETE',
    body: commandBody(expectedRevision, idempotencyKey)
  })
}

export function fetchTaskEvidenceDetail(
  _threadId: string,
  jobId: string,
  taskId: string
): Promise<ApiResponse<{ evidence: import('@shared/contracts/evidence').TaskEvidenceDto }>> {
  return api<{ evidence: import('@shared/contracts/evidence').TaskEvidenceDto }>(
    `/api/jobs/${encodeURIComponent(jobId)}/work/${encodeURIComponent(taskId)}/evidence`
  ).then((res) => {
    // Execution module may return evidence payload directly.
    const raw = res.data as unknown
    if (raw && typeof raw === 'object' && 'evidence' in (raw as object)) {
      return res
    }
    return {
      ...res,
      data: { evidence: raw as import('@shared/contracts/evidence').TaskEvidenceDto }
    }
  })
}

export function confirmDraftMessage(
  _threadId: string,
  draftId: string
): Promise<ApiResponse<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  return getDesignDraft(draftId).then(async (res) => {
    const draft = res.data
    const confirmed = await confirmDesignDraft(draftId, draft.lockRevision)
    return {
      ...confirmed,
      data: {
        messageId: draftId,
        payload: designDraftToPayload(confirmed.data)
      }
    }
  })
}
export function confirmDraftSection(
  _threadId: string,
  draftId: string,
  section: string
): Promise<ApiResponse<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  return getDesignDraft(draftId).then(async (res) => {
    const draft = res.data
    const body = await api<DesignDraftDto>(
      `/api/drafts/${encodeURIComponent(draftId)}/sections/${encodeURIComponent(section)}/confirm`,
      {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: draft.lockRevision })
      }
    )
    return {
      ...body,
      data: { messageId: draftId, payload: designDraftToPayload(body.data) }
    }
  })
}

function mapDesignDraftToSummary(draft: DesignDraftDto): ThreadDraftSummaryDto {
  return {
    messageId: draft.id,
    draftId: draft.id,
    title: draft.title,
    summary: draft.summary,
    status: draft.status,
    linkedPlanId: null,
    designSessionId: null,
    launchedJobId: null,
    createdAt: new Date(draft.createdAt).toISOString(),
    plan: null
  }
}

function mapPlanningSessionToJob(session: {
  id: string
  sourceDraftId: string
  status: string
  treeRevision: number
  publishedJobId: string | null
  createdAt: number
  updatedAt: number
}): PlanningSessionViewDto {
  const status = toPlanningSessionStatus(
    session.status === 'plan_editing' || session.status === 'ready_to_publish'
      ? 'plan_editing'
      : session.status === 'planning' || session.status === 'queued'
        ? 'planning'
        : session.status === 'published'
          ? 'pending'
          : session.status
  )
  const planning =
    status === 'planning' || session.status === 'queued' || session.status === 'planning'
  return {
    id: session.id,
    threadId: '',
    draftMessageId: session.sourceDraftId,
    title: `Planning ${session.id}`,
    summary: '',
    status,
    workspacePath: '',
    abilities: [],
    planProgress: {
      phase: planning ? 'planning' : status === 'failed' ? 'failed' : 'plan_ready',
      status: planning ? 'running' : status === 'failed' ? 'failed' : 'completed',
      contextsRegistered: 0,
      contextsTotal: 0
    },
    taskProgress: {
      phase: 'idle',
      status: 'pending',
      currentIndex: 0,
      total: 0,
      tasks: []
    },
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    planRevision: session.treeRevision,
    designSessionId: session.id,
    planConfirmedAt: session.publishedJobId ? Math.floor(session.updatedAt / 1000) : null
  }
}

export async function fetchThreadDrafts(
  threadId: string
): Promise<ApiResponse<{ drafts: ThreadDraftSummaryDto[] }>> {
  const { fetchThread } = await import('./threads')
  const threadRes = await fetchThread(threadId)
  const projectId = threadRes.data.projectId
  const draftsRes = await listDesignDrafts()
  const drafts = draftsRes.data
    .filter((d) => d.projectId === projectId && d.status !== 'archived')
    .map(mapDesignDraftToSummary)
  return { ...draftsRes, data: { drafts } }
}

export async function fetchThreadPlans(
  threadId: string
): Promise<ApiResponse<{ plans: PlanningSessionViewDto[] }>> {
  const draftsRes = await fetchThreadDrafts(threadId)
  const plans: PlanningSessionViewDto[] = []
  for (const draft of draftsRes.data.drafts) {
    const sessions = await listPlanningSessionsForDraft(draft.draftId)
    for (const session of sessions.data) {
      plans.push(mapPlanningSessionToJob(session))
    }
  }
  return { ...draftsRes, data: { plans } }
}

export async function confirmExecutionPlan(
  _threadId: string,
  sessionId: string
): Promise<ApiResponse<{ job: PlanningSessionViewDto }>> {
  const current = await getPlanningSession(sessionId)
  const published = await publishPlanningSession(
    sessionId,
    current.data.session.treeRevision,
    `publish:${sessionId}:${current.data.session.treeRevision}`
  )
  const job = mapPlanningSessionToJob({
    ...published.data.session,
    sourceDraftId: published.data.session.sourceDraftId,
    publishedJobId: published.data.jobId
  })
  job.id = published.data.jobId
  return { ...published, data: { job } }
}

export async function launchDesignSession(
  threadId: string,
  designSessionId: string
): Promise<ApiResponse<{ job: PlanningSessionViewDto }>> {
  return confirmExecutionPlan(threadId, designSessionId)
}

export async function freezeReferenceCorpus(
  _threadId: string,
  _designSessionId: string
): Promise<ApiResponse<{ manifest: import('@shared/job-references').JobReferenceManifestDto }>> {
  // Design freezes reference manifest at planning-session creation; no-op success for UI.
  return {
    success: true,
    status: 0,
    message: 'success',
    extra: {},
    data: {
      manifest: {
        revision: 1,
        references: [],
        contentHash: '',
        frozenAt: new Date().toISOString()
      } as unknown as import('@shared/job-references').JobReferenceManifestDto
    }
  }
}

export async function updateJobPlanNode(
  _threadId: string,
  sessionId: string,
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
): Promise<ApiResponse<{ job: PlanningSessionViewDto }>> {
  void patch.referenceReason
  const current = await getPlanningSession(sessionId)
  const expectedRevision = patch.expectedPlanRevision ?? current.data.session.treeRevision
  await patchPlanningTreeNode(sessionId, patch.nodeRef, {
    expectedRevision,
    title: patch.title,
    description: patch.description,
    successCriteria: patch.successCriteria,
    contextMarkdown: patch.contextMarkdown,
    abilityCode: patch.abilityCode,
    coreCode: patch.coreCode,
    referenceIds: patch.referenceIds
  })
  const refreshed = await getPlanningSession(sessionId)
  return {
    ...refreshed,
    data: { job: mapPlanningSessionToJob(refreshed.data.session) }
  }
}

export async function confirmPlanNode(
  _threadId: string,
  sessionId: string,
  nodeRef: string
): Promise<ApiResponse<{ job: PlanningSessionViewDto }>> {
  const current = await getPlanningSession(sessionId)
  await confirmPlanningTreeNode(sessionId, nodeRef, current.data.session.treeRevision)
  const refreshed = await getPlanningSession(sessionId)
  return {
    ...refreshed,
    data: { job: mapPlanningSessionToJob(refreshed.data.session) }
  }
}

export function updateDraftContent(
  _threadId: string,
  draftId: string,
  patch: {
    title?: string
    summary?: string
    userFlow?: string
    techStack?: string
    requirementsContractMarkdown?: string
  }
): Promise<ApiResponse<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  return getDesignDraft(draftId).then(async (res) => {
    const body = await api<DesignDraftDto>(`/api/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        expectedRevision: res.data.lockRevision,
        title: patch.title,
        summary: patch.summary,
        userFlow: patch.userFlow,
        techStack: patch.techStack,
        requirementsMarkdown: patch.requirementsContractMarkdown
      })
    })
    return {
      ...body,
      data: { messageId: draftId, payload: designDraftToPayload(body.data) }
    }
  })
}

export async function updateDraftAbilityCores(
  _threadId: string,
  messageId: string,
  selections: Array<{ abilityCode: string; coreCode: string }>
): Promise<ApiResponse<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  const current = await getDesignDraft(messageId)
  const byCode = new Map(selections.map((s) => [s.abilityCode, s.coreCode]))
  const abilities = current.data.abilities.map((ability) => {
    const core = byCode.get(ability.abilityCode)
    return core ? { ...ability, recommendedCoreCode: core } : ability
  })
  const updated = await patchDesignAbilities(messageId, current.data.lockRevision, abilities)
  return asDraftPayload(messageId, updated.data)
}

export async function updateDraftExecutionConfig(
  _threadId: string,
  messageId: string,
  config: {
    plannerCoreCode: string
    sliceVerifierCoreCode: string
    milestoneVerifierCoreCode: string
  }
): Promise<ApiResponse<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  const current = await getDesignDraft(messageId)
  const updated = await patchDesignExecutionProfile(
    messageId,
    current.data.lockRevision,
    config
  )
  return asDraftPayload(messageId, updated.data)
}

function asDraftPayload(
  draftId: string,
  draft: DesignDraftDto
): ApiResponse<{ messageId: string; payload: TaskLaunchDraftPayload }> {
  return {
    success: true,
    data: {
      messageId: draftId,
      payload: designDraftToPayload(draft)
    },
    status: 0,
    message: 'success',
    extra: {}
  }
}

export async function unlockDraftForEdit(
  _threadId: string,
  draftMessageId: string
): Promise<ApiResponse<{ draft: TaskLaunchDraftPayload; thread: { id: string } }>> {
  const current = await getDesignDraft(draftMessageId)
  const unlocked = await unlockDesignDraft(draftMessageId, current.data.lockRevision)
  return {
    ...unlocked,
    data: {
      draft: designDraftToPayload(unlocked.data),
      thread: { id: _threadId }
    }
  }
}

export async function unlockRequirementsContract(
  _threadId: string,
  draftMessageId: string
): Promise<
  ApiResponse<{
    messageId: string
    payload: TaskLaunchDraftPayload
  }>
> {
  // Design has no contract-only unlock — full draft unlock restores editability.
  const current = await getDesignDraft(draftMessageId)
  const unlocked = await unlockDesignDraft(draftMessageId, current.data.lockRevision)
  const payload = designDraftToPayload(unlocked.data)
  return {
    ...unlocked,
    data: {
      messageId: draftMessageId,
      payload
    }
  }
}

export async function launchJobFromDraft(
  _threadId: string,
  draftMessageId: string
): Promise<ApiResponse<{ job: PlanningSessionViewDto; draft: TaskLaunchDraftPayload }>> {
  const draftRes = await getDesignDraft(draftMessageId)
  let draft = draftRes.data
  if (draft.status !== 'confirmed') {
    draft = (await confirmDesignDraft(draftMessageId, draft.lockRevision)).data
  }
  const session = await startPlanningSession(draftMessageId, draft.lockRevision)
  const job = mapPlanningSessionToJob(session.data)
  return {
    ...session,
    data: {
      job,
      draft: designDraftToPayload(draft)
    }
  }
}

export async function uploadDraftReferences(
  threadId: string,
  messageId: string,
  files: File[]
): Promise<{ messageId: string; payload: TaskLaunchDraftPayload }> {
  // Upload bytes via thread attachments, then attach metadata on the Design draft.
  const attachments: MessageAttachment[] = []
  for (const file of files) {
    attachments.push(await uploadThreadAttachment(threadId, file))
  }
  let draftRes = await getDesignDraft(messageId)
  let draft = draftRes.data
  for (const attachment of attachments) {
    draftRes = await addDesignDraftReference(messageId, {
      expectedRevision: draft.lockRevision,
      name: attachment.name || attachment.id,
      kind: attachment.mimeType?.startsWith('image/') ? 'image' : 'file',
      description: attachment.name || 'Uploaded reference',
      source: 'attachment',
      mimeType: attachment.mimeType,
      attachmentId: attachment.id,
      assetUrl: attachment.assetUrl
    })
    draft = draftRes.data
  }
  return { messageId, payload: designDraftToPayload(draft) }
}

export async function deleteDraftReference(
  _threadId: string,
  messageId: string,
  referenceId: string
): Promise<ApiResponse<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  const current = await getDesignDraft(messageId)
  const updated = await deleteDesignDraftReference(
    messageId,
    referenceId,
    current.data.lockRevision
  )
  return asDraftPayload(messageId, updated.data)
}

export async function updateDraftReferenceDescription(
  _threadId: string,
  messageId: string,
  referenceId: string,
  description: string
): Promise<ApiResponse<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  const current = await getDesignDraft(messageId)
  const updated = await patchDesignDraftReference(messageId, referenceId, {
    expectedRevision: current.data.lockRevision,
    description
  })
  return asDraftPayload(messageId, updated.data)
}

export async function importDraftReferences(
  threadId: string,
  messageId: string,
  attachmentIds: string[],
  descriptions: Record<string, string> = {}
): Promise<ApiResponse<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  void threadId
  let draftRes = await getDesignDraft(messageId)
  let draft = draftRes.data
  for (const attachmentId of attachmentIds) {
    draftRes = await addDesignDraftReference(messageId, {
      expectedRevision: draft.lockRevision,
      name: attachmentId,
      kind: 'file',
      description: descriptions[attachmentId]?.trim() || 'Imported attachment',
      source: 'attachment',
      attachmentId
    })
    draft = draftRes.data
  }
  return asDraftPayload(messageId, draft)
}

export async function addLocalCorpusDraftReference(
  _threadId: string,
  messageId: string,
  input: {
    localPath: string
    name: string
    description: string
    kind?: 'file' | 'directory'
  }
): Promise<ApiResponse<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  const current = await getDesignDraft(messageId)
  const updated = await addDesignDraftReference(messageId, {
    expectedRevision: current.data.lockRevision,
    name: input.name,
    kind: input.kind === 'directory' ? 'directory' : 'file',
    description: input.description,
    source: 'local_corpus',
    localPath: input.localPath,
    resolvedPath: input.localPath
  })
  return asDraftPayload(messageId, updated.data)
}
