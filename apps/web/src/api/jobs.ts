/**
 * Design / planning adapter for the web UI.
 *
 * Bridges legacy "thread + draft + plan" call shapes onto Design + Execution APIs
 * (`./design`, `./jobs-api`). Prefer `@codetask/contracts` types and `./jobs-api`
 * for new Execution-only surfaces. Retire functions here as call sites move to
 * design.ts / jobs-api.ts directly.
 */
import { authHeaders } from '@renderer/auth/token'
import type {
  MessageAttachment,
  TaskProgressDto,
  ThreadDraftSummaryDto,
  FlatTaskPlan,
  UserDraftListItemDto,
  PlanningSessionViewDto
} from '@codetask/contracts'
import { toPlanningSessionStatus } from '@codetask/contracts'
import { designDraftToPayload, type TaskLaunchDraftPayload } from '@renderer/lib/draftForm'
import { i18n } from '@renderer/i18n'
import { api, ApiError } from './client'
import type { ApiSuccess } from './types'
import {
  addDesignDraftReference,
  confirmDesignDraft,
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
import { newIdempotencyKey, resolveJobsApi, type ExecutionJob } from './jobs-api'

export type { ExecutionJob }
export type { PlanningSessionViewDto } from '@codetask/contracts'
export { toPlanningSessionStatus } from '@codetask/contracts'

/** Map an Execution job into the plan-review list shape (no fake runtime fields). */
export function mapExecutionJobToPlanView(job: ExecutionJob): PlanningSessionViewDto {
  const state = job.state
  const status =
    state === 'succeeded'
      ? 'completed'
      : state === 'queued'
        ? 'pending'
        : state === 'cancelling'
          ? 'cancelled'
          : toPlanningSessionStatus(state)
  return {
    id: job.id,
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
      phase: state === 'running' || state === 'pausing' ? 'running' : 'idle',
      status:
        state === 'running' || state === 'pausing'
          ? 'running'
          : state === 'failed'
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
  FlatTaskPlan as ThreadJobPlan,
  UserDraftListItemDto as UserDraftListItem
} from '@codetask/contracts'

export type ThreadJobPlanTask = FlatTaskPlan

export type TaskProgressItem = TaskProgressDto['tasks'][number]

export async function uploadConversationAttachment(
  conversationId: string,
  file: File
): Promise<MessageAttachment> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`/api/conversations/${conversationId}/attachments`, {
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
    throw new ApiError(
      String(i18n.global.t('workspace.tasks.uploadInvalidResponse')),
      res.status,
      body
    )
  }
  return body.data.attachment
}

export async function fetchLatestThreadJob(
  threadId: string
): Promise<ApiSuccess<{ job: PlanningSessionViewDto | null }>> {
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
): Promise<ApiSuccess<{ jobs: ExecutionJob[]; total: number }>> {
  return resolveJobsApi().fetchJobs(status, page, limit, q)
}

export function fetchJob(jobId: string): Promise<ApiSuccess<{ job: ExecutionJob }>> {
  return resolveJobsApi().fetchJob(jobId)
}

function commandBody(expectedRevision: number, idempotencyKey: string): string {
  return JSON.stringify({ expectedRevision, idempotencyKey })
}

export function pauseJob(
  jobId: string,
  expectedRevision = 0,
  idempotencyKey = newIdempotencyKey()
): Promise<ApiSuccess<{ job: ExecutionJob }>> {
  return resolveJobsApi().pause(jobId, expectedRevision, idempotencyKey)
}

export function continueJob(
  jobId: string,
  expectedRevision = 0,
  idempotencyKey = newIdempotencyKey(),
  authorizeReplay?: boolean
): Promise<ApiSuccess<{ job: ExecutionJob }>> {
  return resolveJobsApi().continue(jobId, expectedRevision, idempotencyKey, authorizeReplay)
}

export function restartJob(
  jobId: string,
  expectedRevision = 0,
  idempotencyKey = newIdempotencyKey()
): Promise<ApiSuccess<{ job: ExecutionJob }>> {
  return resolveJobsApi().restartExecution(jobId, expectedRevision, idempotencyKey)
}

export function fetchUserDrafts(options?: {
  q?: string
  completion?: 'all' | 'incomplete' | 'complete'
}): Promise<ApiSuccess<{ drafts: UserDraftListItemDto[] }>> {
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
        projectId: d.projectId,
        projectTitle: '',
        launched: false,
        jobId: null
      }))
      return { ...res, data: { drafts } }
    }
    return { ...res, data: raw as { drafts: UserDraftListItemDto[] } }
  })
}

export function deleteUserDraft(
  draftId: string
): Promise<ApiSuccess<{ mode: 'removed' | 'archived'; keptJobId: string | null }>> {
  return api<{ archived: boolean }>(`/api/drafts/${encodeURIComponent(draftId)}`, {
    method: 'DELETE'
  }).then((res) => ({
    ...res,
    data: { mode: 'archived' as const, keptJobId: null }
  }))
}

export function retryJobPlanning(
  sessionId: string
): Promise<ApiSuccess<{ job: PlanningSessionViewDto }>> {
  return api<unknown>(`/api/planning-sessions/${encodeURIComponent(sessionId)}/retry`, {
    method: 'POST',
    body: '{}'
  }).then(async (retryRes) => {
    const current = await getPlanningSession(sessionId)
    return {
      ...retryRes,
      data: { job: mapPlanningSessionToJob(current.data.session) }
    }
  })
}

export function deleteJob(
  jobId: string,
  expectedRevision = 0,
  idempotencyKey = newIdempotencyKey()
): Promise<ApiSuccess<{ deleted: boolean }>> {
  return api<{ deleted: boolean }>(`/api/jobs/${jobId}`, {
    method: 'DELETE',
    body: commandBody(expectedRevision, idempotencyKey)
  })
}

export function fetchTaskEvidenceDetail(
  jobId: string,
  taskId: string
): Promise<ApiSuccess<{ evidence: import('@codetask/contracts').TaskEvidenceDto }>> {
  return api<{ evidence: import('@codetask/contracts').TaskEvidenceDto }>(
    `/api/jobs/${encodeURIComponent(jobId)}/work/${encodeURIComponent(taskId)}/evidence`
  ).then((res) => {
    // Execution module may return evidence payload directly.
    const raw = res.data as unknown
    if (raw && typeof raw === 'object' && 'evidence' in (raw as object)) {
      return res
    }
    return {
      ...res,
      data: { evidence: raw as import('@codetask/contracts').TaskEvidenceDto }
    }
  })
}

export function confirmDraftMessage(
  draftId: string
): Promise<ApiSuccess<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
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
): Promise<ApiSuccess<{ drafts: ThreadDraftSummaryDto[] }>> {
  const threadRes = await api<{ projectId: string }>(
    `/api/conversations/${encodeURIComponent(threadId)}`
  )
  const projectId = threadRes.data.projectId
  const draftsRes = await listDesignDrafts()
  const drafts = draftsRes.data
    .filter((d) => d.projectId === projectId && d.status !== 'archived')
    .map(mapDesignDraftToSummary)
  return { ...draftsRes, data: { drafts } }
}

export async function fetchThreadPlans(
  threadId: string
): Promise<ApiSuccess<{ plans: PlanningSessionViewDto[] }>> {
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
  sessionId: string
): Promise<ApiSuccess<{ job: PlanningSessionViewDto }>> {
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
  designSessionId: string
): Promise<ApiSuccess<{ job: PlanningSessionViewDto }>> {
  return confirmExecutionPlan(designSessionId)
}

export async function updateJobPlanNode(
  sessionId: string,
  patch: {
    nodeRef: string
    expectedPlanRevision?: number
    title?: string
    description?: string
    successCriteria?: string
    contextMarkdown?: string
    abilityCode?: string
    providerCode?: string
    referenceIds?: string[]
    referenceReason?: string
  }
): Promise<ApiSuccess<{ job: PlanningSessionViewDto }>> {
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
    providerCode: patch.providerCode,
    referenceIds: patch.referenceIds
  })
  const refreshed = await getPlanningSession(sessionId)
  return {
    ...refreshed,
    data: { job: mapPlanningSessionToJob(refreshed.data.session) }
  }
}

export function updateDraftContent(
  draftId: string,
  patch: {
    title?: string
    summary?: string
    userFlow?: string
    techStack?: string
    requirementsContractMarkdown?: string
  }
): Promise<ApiSuccess<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
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
  messageId: string,
  selections: Array<{ abilityCode: string; providerCode: string }>
): Promise<ApiSuccess<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  const current = await getDesignDraft(messageId)
  const byCode = new Map(selections.map((s) => [s.abilityCode, s.providerCode]))
  const abilities = current.data.abilities.map((ability) => {
    const core = byCode.get(ability.abilityCode)
    return core ? { ...ability, recommendedCoreCode: core } : ability
  })
  const updated = await patchDesignAbilities(messageId, current.data.lockRevision, abilities)
  return asDraftPayload(messageId, updated.data)
}

export async function updateDraftExecutionConfig(
  messageId: string,
  config: {
    plannerCoreCode: string
    sliceVerifierCoreCode: string
    milestoneVerifierCoreCode: string
  }
): Promise<ApiSuccess<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  const current = await getDesignDraft(messageId)
  const updated = await patchDesignExecutionProfile(messageId, current.data.lockRevision, config)
  return asDraftPayload(messageId, updated.data)
}

function asDraftPayload(
  draftId: string,
  draft: DesignDraftDto
): ApiSuccess<{ messageId: string; draftId: string; payload: TaskLaunchDraftPayload }> {
  return {
    success: true,
    data: {
      messageId: draftId,
      draftId,
      payload: designDraftToPayload(draft)
    },
    requestId: `design:${draftId}`
  }
}

export async function unlockDraftForEdit(
  draftMessageId: string
): Promise<ApiSuccess<{ draft: TaskLaunchDraftPayload }>> {
  const current = await getDesignDraft(draftMessageId)
  const unlocked = await unlockDesignDraft(draftMessageId, current.data.lockRevision)
  return {
    ...unlocked,
    data: {
      draft: designDraftToPayload(unlocked.data)
    }
  }
}

export async function unlockRequirementsContract(draftMessageId: string): Promise<
  ApiSuccess<{
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
  draftMessageId: string
): Promise<ApiSuccess<{ job: PlanningSessionViewDto; draft: TaskLaunchDraftPayload }>> {
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
    attachments.push(await uploadConversationAttachment(threadId, file))
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
  messageId: string,
  referenceId: string
): Promise<ApiSuccess<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  const current = await getDesignDraft(messageId)
  const updated = await deleteDesignDraftReference(
    messageId,
    referenceId,
    current.data.lockRevision
  )
  return asDraftPayload(messageId, updated.data)
}

export async function updateDraftReferenceDescription(
  messageId: string,
  referenceId: string,
  description: string
): Promise<ApiSuccess<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
  const current = await getDesignDraft(messageId)
  const updated = await patchDesignDraftReference(messageId, referenceId, {
    expectedRevision: current.data.lockRevision,
    description
  })
  return asDraftPayload(messageId, updated.data)
}

export async function importDraftReferences(
  messageId: string,
  attachmentIds: string[],
  descriptions: Record<string, string> = {}
): Promise<ApiSuccess<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
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
  messageId: string,
  input: {
    localPath: string
    name: string
    description: string
    kind?: 'file' | 'directory'
  }
): Promise<ApiSuccess<{ messageId: string; payload: TaskLaunchDraftPayload }>> {
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
