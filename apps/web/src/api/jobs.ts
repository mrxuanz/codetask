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
  FlatTaskPlan,
  PlanningSessionViewDto
} from '@codetask/contracts'
import { designDraftToPayload, type TaskLaunchDraftPayload } from '@renderer/lib/draftForm'
import { i18n } from '@renderer/i18n'
import { api, ApiError } from './client'
import type { ApiSuccess } from './types'
import {
  addDesignDraftReference,
  confirmDesignDraft,
  confirmPlanningTree,
  deleteDesignDraftReference,
  getDesignDraft,
  getPlanningSession,
  patchDesignAbilities,
  patchDesignDraftReference,
  patchDesignExecutionProfile,
  patchPlanningTreeNode,
  publishPlanningSession,
  startPlanningSession,
  unlockDesignDraft,
  type DesignDraftDto
} from './design'
import { resolveJobsApi, type ExecutionJob } from './jobs-api'
import { mapExecutionJobToPlanView, mapPlanningSessionToJob } from './planning-view-mappers'

export type { ExecutionJob }
export type { PlanningSessionViewDto } from '@codetask/contracts'
export { toPlanningSessionStatus } from '@codetask/contracts'
export { mapExecutionJobToPlanView } from './planning-view-mappers'

export type {
  MessageAttachment,
  PlanProgressDto as PlanProgress,
  TaskProgressDto as TaskProgress,
  TaskProgressDto,
  FlatTaskPlan,
  FlatTaskPlan as ThreadJobPlan
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

export function fetchJob(jobId: string): Promise<ApiSuccess<{ job: ExecutionJob }>> {
  return resolveJobsApi().fetchJob(jobId)
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
      data: { job: mapPlanningSessionToJob(current.data.session, current.data.tree) }
    }
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

export async function confirmExecutionPlan(
  sessionId: string
): Promise<ApiSuccess<{ job: PlanningSessionViewDto }>> {
  const current = await getPlanningSession(sessionId)
  if (current.data.session.publishedJobId) {
    const existing = await resolveJobsApi().fetchJob(current.data.session.publishedJobId)
    return { ...existing, data: { job: mapExecutionJobToPlanView(existing.data.job) } }
  }
  if (!current.data.tree) {
    throw new ApiError('Planning tree is not ready', 409, current.data, 'planning.tree_missing')
  }

  let revision = current.data.session.treeRevision
  let tree = current.data.tree
  const hasUnconfirmedNodes = tree.milestones.some(
    (milestone) =>
      !milestone.confirmed ||
      milestone.slices.some(
        (slice) => !slice.confirmed || slice.tasks.some((task) => !task.confirmed)
      )
  )
  if (hasUnconfirmedNodes) {
    const confirmed = await confirmPlanningTree(sessionId, revision)
    tree = confirmed.data
    revision = tree.revision
  }
  const published = await publishPlanningSession(
    sessionId,
    revision,
    `publish:${sessionId}:${revision}`
  )
  try {
    const execution = await resolveJobsApi().fetchJob(published.data.jobId)
    return { ...published, data: { job: mapExecutionJobToPlanView(execution.data.job) } }
  } catch {
    const job = mapPlanningSessionToJob(published.data.session, tree)
    job.id = published.data.jobId
    return { ...published, data: { job } }
  }
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
    referenceIds: patch.referenceIds,
    referenceReason: patch.referenceReason
  })
  const refreshed = await getPlanningSession(sessionId)
  return {
    ...refreshed,
    data: { job: mapPlanningSessionToJob(refreshed.data.session, refreshed.data.tree) }
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
  const job = mapPlanningSessionToJob(session.data, null, draft)
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
