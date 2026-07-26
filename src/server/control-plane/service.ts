import { randomUUID } from 'crypto'
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { AppError } from '../error'
import { getDb } from '../db'
import { threadJobs } from '../db/schema'
import type { JobSseEvent, ThreadJobDto } from './types'
import type { TaskLaunchDraftPayload, TaskLaunchDraftReference } from '../conversation/draft/types'
import { draftPayloadToClientJson } from '../conversation/draft/normalize'
import { isDraftEditable } from '../conversation/draft/status'
import { saveThreadAttachment } from '../conversation/attachments'
import { getMessage, listMessages, updateMessagePayload } from '../conversation/messages'
import { getThreadRow } from '../threads/service'
import type { SavedJobPlan } from '../planner/plan-types'
import { PLAN_WORKSPACE_STATUSES, TASK_LIST_JOB_STATUSES } from './constants'
import { getAppContext } from '../bootstrap'
import { signAssetUrlsInValue } from '../auth/sign-asset-url'
import { getThreadJob as getThreadJobRow, getUserJob as getUserJobRow, mapJob } from './repository'

export function initJobService(): void {
  getAppContext()
}

export { mapJob, updateJobRow, updateJobRowForSnapshot } from './repository'

export async function getUserJob(username: string, jobId: string): Promise<ThreadJobDto | null> {
  const job = await getUserJobRow(username, jobId)
  if (!job) return null
  const { attachExecutionQueueMeta } = await import('./execution-queue-meta')
  return attachExecutionQueueMeta(job, username)
}

export async function getThreadJob(
  username: string,
  threadId: string,
  jobId: string
): Promise<ThreadJobDto | null> {
  const job = await getThreadJobRow(username, threadId, jobId)
  if (!job) return null
  const { attachExecutionQueueMeta } = await import('./execution-queue-meta')
  return attachExecutionQueueMeta(job, username)
}

import { slimJobForSse, slimTaskProgressForSse } from './progress-sse'

function slimJobSseEvent(event: JobSseEvent): JobSseEvent {
  switch (event.event) {
    case 'task_progress':
      return {
        event: 'task_progress',
        data: { taskProgress: slimTaskProgressForSse(event.data.taskProgress) }
      }
    case 'job_snapshot':
      return { event: 'job_snapshot', data: { job: slimJobForSse(event.data.job) } }
    case 'job_done':
      return { event: 'job_done', data: { job: slimJobForSse(event.data.job) } }
    default:
      return event
  }
}

export function emitJobEvent(jobId: string, event: JobSseEvent): void {
  getAppContext().eventBus.emit(`job:${jobId}`, slimJobSseEvent(event))
}

export {
  emitJobDone,
  emitJobError,
  emitJobProgressAfterPersist,
  emitJobSnapshot,
  emitJobSseEvent,
  emitTaskProgressDelta,
  type JobProgressEmitMode
} from './progress-emit'

export function subscribeJobEvents(
  jobId: string,
  listener: (event: JobSseEvent) => void
): () => void {
  return getAppContext().eventBus.subscribe(`job:${jobId}`, (event) => {
    listener(event as JobSseEvent)
  })
}

export async function listUserJobs(
  username: string,
  options?: { status?: string; page?: number; limit?: number; q?: string | undefined }
): Promise<{ jobs: ThreadJobDto[]; total: number }> {
  const db = getDb()
  const page = Math.max(1, options?.page ?? 1)
  const limit = Math.min(100, Math.max(1, options?.limit ?? 50))
  const offset = (page - 1) * limit
  const status = options?.status?.trim()
  const q = options?.q?.trim().toLowerCase()

  // Task list is only for jobs whose execution tree was confirmed (enqueued).
  // Planning / plan_editing / pre-confirm failures live in the create workspace.
  const planWorkspace = PLAN_WORKSPACE_STATUSES as readonly string[]
  const statusFilter = status && status !== 'all' && !planWorkspace.includes(status) ? status : null

  let whereClause = and(
    eq(threadJobs.username, username),
    isNotNull(threadJobs.planConfirmedAt),
    statusFilter
      ? eq(threadJobs.status, statusFilter)
      : inArray(threadJobs.status, [...TASK_LIST_JOB_STATUSES])
  )

  if (q) {
    const pattern = `%${q}%`
    whereClause = and(
      whereClause,
      or(
        sql`lower(${threadJobs.title}) like ${pattern}`,
        sql`lower(${threadJobs.summary}) like ${pattern}`,
        sql`lower(${threadJobs.status}) like ${pattern}`
      )
    )
  }

  const rows = await db
    .select()
    .from(threadJobs)
    .where(whereClause)
    .orderBy(desc(threadJobs.updatedAt))
    .limit(limit)
    .offset(offset)

  const countRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(threadJobs)
    .where(whereClause)

  const { attachExecutionQueueMetaBatch } = await import('./execution-queue-meta')
  return {
    jobs: await attachExecutionQueueMetaBatch(
      username,
      await Promise.all(rows.map((row) => mapJob(row)))
    ),
    total: Number(countRows[0]?.count ?? 0)
  }
}

export async function getLatestThreadJob(
  username: string,
  threadId: string
): Promise<ThreadJobDto | null> {
  const { listThreadDesignSessions } = await import('../design-session/service')
  const [designPlans, dbRows] = await Promise.all([
    listThreadDesignSessions(username, threadId),
    getDb()
      .select()
      .from(threadJobs)
      .where(and(eq(threadJobs.threadId, threadId), eq(threadJobs.username, username)))
      .orderBy(desc(threadJobs.updatedAt))
      .limit(1)
  ])

  const latestJob = dbRows[0] ? await mapJob(dbRows[0]) : null
  const latestDesign = designPlans[0] ?? null

  if (!latestJob && !latestDesign) return null
  if (!latestJob) return latestDesign
  if (!latestDesign) return latestJob
  return latestDesign.updatedAt >= latestJob.updatedAt ? latestDesign : latestJob
}

export async function updateDraftAbilityCores(
  username: string,
  threadId: string,
  messageId: string,
  selections: Array<{ abilityCode: string; coreCode: string }>
): Promise<{ messageId: string; payload: Record<string, unknown> }> {
  const message = await getMessage(username, threadId, messageId, { signAssets: false })
  if (!message || message.kind !== 'task-launch-draft') {
    throw AppError.notFound('Draft message not found', 'draft.not_found')
  }

  const payload = message.payload as TaskLaunchDraftPayload | undefined
  if (!payload?.draftId) {
    throw AppError.badRequest('Draft payload invalid', 'draft.invalid_payload')
  }
  if (!isDraftEditable(payload)) {
    throw AppError.badRequest('Draft is already confirmed', 'draft.locked', { reason: 'confirmed' })
  }

  const selectionMap = new Map(selections.map((item) => [item.abilityCode, item.coreCode]))
  const nextPayload: TaskLaunchDraftPayload = {
    ...payload,
    abilities: payload.abilities.map((ability) => {
      const coreCode = selectionMap.get(ability.abilityCode)
      if (!coreCode) return ability
      return { ...ability, recommendedCoreCode: coreCode as typeof ability.recommendedCoreCode }
    })
  }

  const updated = await updateMessagePayload(
    username,
    threadId,
    messageId,
    draftPayloadToClientJson(nextPayload)
  )
  if (!updated?.payload) {
    throw AppError.internal('Failed to update draft', 'turn.unknown')
  }

  return { messageId, payload: updated.payload as Record<string, unknown> }
}

export async function confirmDraftMessage(
  username: string,
  threadId: string,
  messageId: string
): Promise<{ messageId: string; payload: Record<string, unknown> }> {
  const message = await getMessage(username, threadId, messageId, { signAssets: false })
  if (!message || message.kind !== 'task-launch-draft') {
    throw AppError.notFound('Draft message not found', 'draft.not_found')
  }

  const payload = message.payload as TaskLaunchDraftPayload | undefined
  if (!payload?.draftId) {
    throw AppError.badRequest('Draft payload invalid', 'draft.invalid_payload')
  }
  if (!isDraftEditable(payload)) {
    throw AppError.badRequest('Draft is already confirmed', 'draft.locked', { reason: 'confirmed' })
  }

  const confirmedAt = new Date().toISOString()
  const nextPayload: TaskLaunchDraftPayload = {
    ...payload,
    requirementsContract: {
      ...payload.requirementsContract,
      status: 'confirmed',
      confirmedAt
    }
  }

  const updated = await updateMessagePayload(
    username,
    threadId,
    messageId,
    draftPayloadToClientJson(nextPayload)
  )
  if (!updated?.payload) {
    throw AppError.internal('Failed to update draft', 'turn.unknown')
  }

  return { messageId, payload: updated.payload as Record<string, unknown> }
}

function attachmentToReference(
  attachment: {
    id: string
    name: string
    mimeType: string
    kind: 'image' | 'file'
    assetUrl: string
  },
  source: TaskLaunchDraftReference['source'],
  description = ''
): TaskLaunchDraftReference {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    assetUrl: attachment.assetUrl,
    description,
    source
  }
}

async function persistDraftPayload(
  username: string,
  threadId: string,
  messageId: string,
  payload: TaskLaunchDraftPayload
): Promise<{ messageId: string; payload: Record<string, unknown> }> {
  const updated = await updateMessagePayload(
    username,
    threadId,
    messageId,
    draftPayloadToClientJson(payload)
  )
  if (!updated?.payload) {
    throw AppError.internal('Failed to update draft', 'turn.unknown')
  }
  return { messageId, payload: updated.payload as Record<string, unknown> }
}

async function loadDraftPayload(
  username: string,
  threadId: string,
  messageId: string
): Promise<TaskLaunchDraftPayload> {
  const message = await getMessage(username, threadId, messageId, { signAssets: false })
  if (!message || message.kind !== 'task-launch-draft') {
    throw AppError.notFound('Draft message not found', 'draft.not_found')
  }
  const payload = message.payload as TaskLaunchDraftPayload | undefined
  if (!payload?.draftId) {
    throw AppError.badRequest('Draft payload invalid', 'draft.invalid_payload')
  }
  return {
    ...payload,
    references: payload.references ?? [],
    sourceAttachments: payload.sourceAttachments ?? []
  }
}

export async function uploadDraftReferences(
  username: string,
  threadId: string,
  messageId: string,
  files: Array<{ name: string; mimeType: string; buffer: Buffer; description?: string }>
): Promise<{ messageId: string; payload: Record<string, unknown> }> {
  const payload = await loadDraftPayload(username, threadId, messageId)
  if (!isDraftEditable(payload)) {
    throw AppError.badRequest('Draft is already confirmed', 'draft.locked', {
      reason: 'confirmed',
      scope: 'references'
    })
  }
  const existingIds = new Set(payload.references.map((item) => item.id))
  const nextReferences = [...payload.references]

  for (const file of files) {
    const attachment = saveThreadAttachment({
      threadId,
      name: file.name,
      mimeType: file.mimeType,
      buffer: file.buffer
    })
    if (existingIds.has(attachment.id)) continue
    existingIds.add(attachment.id)
    nextReferences.push(attachmentToReference(attachment, 'upload', file.description?.trim() ?? ''))
  }

  const result = await persistDraftPayload(username, threadId, messageId, {
    ...payload,
    references: nextReferences
  })

  return {
    messageId: result.messageId,
    payload: signAssetUrlsInValue(getAppContext().security.authSecret, result.payload) as Record<
      string,
      unknown
    >
  }
}

export async function deleteDraftReference(
  username: string,
  threadId: string,
  messageId: string,
  referenceId: string
): Promise<{ messageId: string; payload: Record<string, unknown> }> {
  const payload = await loadDraftPayload(username, threadId, messageId)
  if (!isDraftEditable(payload)) {
    throw AppError.badRequest('Draft is already confirmed', 'draft.locked', {
      reason: 'confirmed',
      scope: 'references'
    })
  }
  return persistDraftPayload(username, threadId, messageId, {
    ...payload,
    references: payload.references.filter((item) => item.id !== referenceId),
    sourceAttachments: payload.sourceAttachments.filter((item) => item.id !== referenceId)
  })
}

export async function importDraftReferences(
  username: string,
  threadId: string,
  messageId: string,
  attachmentIds: string[],
  descriptions: Record<string, string> = {}
): Promise<{ messageId: string; payload: Record<string, unknown> }> {
  const payload = await loadDraftPayload(username, threadId, messageId)
  if (!isDraftEditable(payload)) {
    throw AppError.badRequest('Draft is already confirmed', 'draft.locked', {
      reason: 'confirmed',
      scope: 'references'
    })
  }
  const messages = await listMessages(username, threadId, 200, { signAssets: false })
  const existingIds = new Set(payload.references.map((item) => item.id))
  const nextReferences = [...payload.references]

  for (const attachmentId of attachmentIds) {
    if (existingIds.has(attachmentId)) continue
    const fromMessage = messages.find((msg) =>
      msg.attachments.some((attachment) => attachment.id === attachmentId)
    )
    const attachment = fromMessage?.attachments.find((item) => item.id === attachmentId)
    if (!attachment) continue
    existingIds.add(attachment.id)
    nextReferences.push(
      attachmentToReference(attachment, 'import', descriptions[attachmentId]?.trim() ?? '')
    )
  }

  return persistDraftPayload(username, threadId, messageId, {
    ...payload,
    references: nextReferences
  })
}

export async function updateDraftReferenceDescription(
  username: string,
  threadId: string,
  messageId: string,
  referenceId: string,
  description: string
): Promise<{ messageId: string; payload: Record<string, unknown> }> {
  const payload = await loadDraftPayload(username, threadId, messageId)
  if (!isDraftEditable(payload)) {
    throw AppError.badRequest('Draft is already confirmed', 'draft.locked', {
      reason: 'confirmed',
      scope: 'references'
    })
  }
  const trimmed = description.trim()
  const nextReferences = [...payload.references]
  const index = nextReferences.findIndex((item) => item.id === referenceId)
  if (index >= 0) {
    const existing = nextReferences[index]
    if (!existing) throw AppError.notFound('Reference not found', 'draft.reference_not_found')
    nextReferences[index] = { ...existing, description: trimmed }
  } else {
    const attachment = payload.sourceAttachments.find((item) => item.id === referenceId)
    if (!attachment) {
      throw AppError.notFound('Reference not found', 'draft.reference_not_found')
    }
    nextReferences.push(attachmentToReference(attachment, 'message', trimmed))
  }
  return persistDraftPayload(username, threadId, messageId, {
    ...payload,
    references: nextReferences
  })
}

export async function addLocalCorpusDraftReference(
  username: string,
  threadId: string,
  messageId: string,
  input: {
    localPath: string
    name: string
    description: string
    kind?: 'file' | 'directory' | undefined
  }
): Promise<{ messageId: string; payload: Record<string, unknown> }> {
  const payload = await loadDraftPayload(username, threadId, messageId)
  if (!isDraftEditable(payload)) {
    throw AppError.badRequest('Draft is already confirmed', 'draft.locked', {
      reason: 'confirmed',
      scope: 'references'
    })
  }

  const { resolveLocalCorpusPath, inferReferenceKind, assertLocalCorpusFileAllowed } =
    await import('../reference-corpus/paths')
  const description = input.description.trim()
  if (!description) {
    throw AppError.badRequest('Description is required', 'draft.invalid_payload', {
      field: 'description'
    })
  }

  let resolvedPath: string
  try {
    resolvedPath = resolveLocalCorpusPath(input.localPath)
  } catch (error) {
    throw AppError.badRequest('Invalid local corpus path', 'draft.invalid_payload', {
      detail: error instanceof Error ? error.message : undefined
    })
  }

  const inferredKind = inferReferenceKind(resolvedPath)
  const kind = input.kind ?? inferredKind
  if (kind === 'file') {
    try {
      assertLocalCorpusFileAllowed('file')
    } catch (error) {
      throw AppError.badRequest('Single-file local corpus not allowed', 'sandbox.required', {
        detail: error instanceof Error ? error.message : undefined
      })
    }
  }

  const ref: TaskLaunchDraftReference = {
    id: `ref-${randomUUID()}`,
    source: 'local_corpus',
    name: input.name.trim() || resolvedPath.split('/').pop() || 'local-corpus',
    kind: kind === 'directory' ? 'directory' : inferredKind === 'directory' ? 'directory' : 'file',
    mimeType: 'application/octet-stream',
    assetUrl: '',
    description,
    localPath: input.localPath.trim()
  }

  return persistDraftPayload(username, threadId, messageId, {
    ...payload,
    references: [...payload.references, ref]
  })
}

export async function launchJobFromDraft(
  username: string,
  threadId: string,
  draftMessageId: string
): Promise<ThreadJobDto> {
  const { confirmDraftAndStartPlanning } = await import('./draft-plan')
  const result = await confirmDraftAndStartPlanning(username, threadId, draftMessageId)
  return result.job
}

/** @deprecated Prefer commitDesignPlanReady — kept as a thin facade for callers. */
export async function commitPlanReadyFenced(
  jobId: string,
  runId: string,
  savedPlan: SavedJobPlan,
  counts: { milestones: number; slices: number; tasks: number }
): Promise<boolean> {
  const db = getDb()
  const rows = await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1)
  const job = rows[0]
  let phaseAdvance:
    | { username: string; threadId: string; coreCode: string; draftMessageId: string }
    | undefined
  if (job) {
    const threadRow = await getThreadRow(job.username, job.threadId)
    if (threadRow) {
      phaseAdvance = {
        username: job.username,
        threadId: job.threadId,
        coreCode: threadRow.coreCode,
        draftMessageId: job.draftMessageId
      }
    }
  }
  const { commitDesignPlanReady } = await import('../design-session/planner')
  return commitDesignPlanReady(jobId, runId, savedPlan, counts, phaseAdvance)
}

/** Single planning entry: always scheduleDesignSessionPlanning → runDesignPlanner. */
export function scheduleJobPlanning(
  username: string,
  threadId: string,
  jobId: string,
  draft: TaskLaunchDraftPayload,
  workspacePath: string,
  coreCode: string
): void {
  void import('../design-session/planner').then(({ scheduleDesignSessionPlanning }) => {
    scheduleDesignSessionPlanning(username, threadId, jobId, draft, workspacePath, coreCode)
  })
}

export async function retryJobPlanning(username: string, jobId: string): Promise<ThreadJobDto> {
  const { retryDesignSessionPlanning } = await import('../design-session/planner')
  return retryDesignSessionPlanning(username, jobId)
}

/** @deprecated Prefer pushDesignPlanningProgressFenced — thin facade. */
export async function pushPlanningProgressFenced(
  jobId: string,
  runId: string,
  done: number,
  partialPlan: SavedJobPlan,
  planOutline: import('../planner/plan-types').PlannerRegisteredPlan
): Promise<void> {
  const { pushDesignPlanningProgressFenced } = await import('../design-session/planner')
  return pushDesignPlanningProgressFenced(jobId, runId, done, partialPlan, planOutline)
}

export async function getTaskEvidenceDetailForUser(input: {
  username: string
  threadId: string
  jobId: string
  taskId: string
}): Promise<{ evidence: import('@shared/contracts/evidence').TaskEvidenceDto } | null> {
  const job = await getThreadJob(input.username, input.threadId, input.jobId)
  if (!job) return null
  const task = job.taskProgress.tasks.find((item) => item.id === input.taskId)
  if (!task) return null

  const { hydrateTaskEvidence, getTaskEvidenceDetail } = await import('./evidence/store')
  const dataDir = getAppContext().dataDir

  if (task.evidenceArtifactId) {
    const evidence = await getTaskEvidenceDetail({
      dataDir,
      artifactId: task.evidenceArtifactId
    })
    return evidence ? { evidence } : null
  }

  const hydrated = await hydrateTaskEvidence(dataDir, task.evidence, null)
  if (!hydrated) return null
  if (hydrated.evidence.length === 0 && hydrated.evidenceRef) return null
  return { evidence: hydrated }
}
