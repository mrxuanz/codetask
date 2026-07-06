import { randomUUID } from 'crypto'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { isDesignSessionId } from '@shared/design-session'
import { AppError } from '../error'
import { getDb } from '../db'
import { saveJobPlan, savePlanProgress } from '../db/job-plan'
import { threadJobs } from '../db/schema'
import type { JobSseEvent, PlanProgressDto, ThreadJobDto } from './types'
import type { TaskLaunchDraftPayload, TaskLaunchDraftReference } from '../conversation/draft/types'
import {
  draftPayloadToClientJson,
  ensureDraftPlanningAbilities
} from '../conversation/draft/normalize'
import { isDraftEditable } from '../conversation/draft/status'
import { saveThreadAttachment } from '../conversation/attachments'
import { getMessage, listMessages, updateMessagePayload } from '../conversation/messages'
import { ensureCoreAvailable, type SupportedCoreCode } from '../conversation/cores'
import { ensureRuntimeRoot, streamAgentTurn } from '../agent-runtime/runner'
import { resolveCoreModel } from '../conversation/models'
import { getThreadRow } from '../threads/service'
import { getProject } from '../projects/service'
import { buildPlannerUserMessage } from '../planner/prompts'
import {
  resolveDraftReferenceReadRoots,
  resolveReferenceManifestReadRoots
} from '../sandbox/reference-roots'
import { resolvePlannerPromptBody } from '../settings/prompts'
import { resolvePlannerCoreCode } from '../settings/control-plane'
import { buildPlannerMcpUrl } from '../planner/mcp/url'
import {
  registerPlannerMcpSession,
  unregisterPlannerMcpSession,
  type PlannerMcpSession
} from '../planner/mcp/session'
import {
  defaultPlanProgress,
  defaultTaskProgress,
  flattenRegisteredPlan,
  buildPartialPlanFromContexts
} from '../planner/save-plan'
import type { SavedJobPlan } from '../planner/plan-types'
import { countPlanUnits } from '../planner/mcp/normalize'
import { plannerSandboxDebug } from '../debug/planner-sandbox'
import { planFailureFromSandboxError } from '../sandbox/sandbox-failure'
import { createTurnError } from '../../shared/turn-errors.ts'
import { TASK_LIST_JOB_STATUSES } from './constants'
import { getAppContext } from '../bootstrap'
import { signAssetUrlsInValue } from '../auth/sign-asset-url'
import {
  getThreadJob as getThreadJobRow,
  getUserJob as getUserJobRow,
  mapJob,
  updateJobRow
} from './repository'
import { loadJobReferenceManifest } from './reference-manifest'
import { enqueueJobSseEvent } from '../context/event-bus'

export function initJobService(): void {
  getAppContext()
}

export { mapJob, updateJobRow, updateJobRowForSnapshot } from './repository'

export async function getUserJob(username: string, jobId: string): Promise<ThreadJobDto | null> {
  const job = await getUserJobRow(username, jobId)
  if (!job) return null
  if (isDesignSessionId(jobId)) return job
  return reconcileStaleJobIfNeeded(username, job)
}

export async function getThreadJob(
  username: string,
  threadId: string,
  jobId: string
): Promise<ThreadJobDto | null> {
  const job = await getThreadJobRow(username, threadId, jobId)
  if (!job) return null
  if (isDesignSessionId(jobId)) return job
  return reconcileStaleJobIfNeeded(username, job)
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

import { reconcileJobsForUser, reconcileStaleJobIfNeeded } from './reconcile'
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
  getAppContext().eventBus.emit(jobId, slimJobSseEvent(event))
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
  return getAppContext().eventBus.subscribe(jobId, listener)
}

export async function listUserJobs(
  username: string,
  options?: { status?: string; page?: number; limit?: number; q?: string }
): Promise<{ jobs: ThreadJobDto[]; total: number }> {
  const db = getDb()
  const page = Math.max(1, options?.page ?? 1)
  const limit = Math.min(100, Math.max(1, options?.limit ?? 50))
  const offset = (page - 1) * limit
  const status = options?.status?.trim()
  const q = options?.q?.trim().toLowerCase()

  let whereClause =
    status && status !== 'all'
      ? and(eq(threadJobs.username, username), eq(threadJobs.status, status))
      : and(
          eq(threadJobs.username, username),
          inArray(threadJobs.status, [...TASK_LIST_JOB_STATUSES])
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

  return {
    jobs: await reconcileJobsForUser(username, await Promise.all(rows.map((row) => mapJob(row)))),
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
    nextReferences[index] = { ...nextReferences[index], description: trimmed }
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
    kind?: 'file' | 'directory'
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

async function commitPlanReady(
  jobId: string,
  _username: string,
  savedPlan: SavedJobPlan,
  counts: { milestones: number; slices: number; tasks: number }
): Promise<boolean> {
  const planReady: PlanProgressDto = {
    phase: 'plan_ready',
    status: 'completed',
    contextsRegistered: counts.tasks,
    contextsTotal: counts.tasks,
    milestones: counts.milestones,
    slices: counts.slices,
    tasks: counts.tasks,
    progressCode: 'plan.plan_ready',
    progressParams: { tasks: counts.tasks },
    message: null
  }

  const initialTaskProgress = defaultTaskProgress(savedPlan.tasks)

  const jobAfterPlan = await updateJobRow(jobId, {
    status: 'plan_editing',
    plan: savedPlan,
    planProgress: planReady,
    taskProgress: initialTaskProgress,
    lastError: null
  })
  if (!jobAfterPlan) return false

  const db = getDb()
  const rows = await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1)
  const fullJob = rows[0] ? await mapJob(rows[0], { includePlan: true }) : jobAfterPlan
  emitJobEvent(jobId, { event: 'plan_progress', data: { planProgress: planReady } })
  emitJobEvent(jobId, { event: 'task_progress', data: { taskProgress: initialTaskProgress } })
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job: fullJob } })
  emitJobEvent(jobId, { event: 'job_done', data: { job: fullJob } })
  return true
}

async function runJob(
  username: string,
  threadId: string,
  jobId: string,
  draft: TaskLaunchDraftPayload,
  workspacePath: string,
  coreCode: string
): Promise<void> {
  const { findWorkloadOccupant } = await import('./workload-slot')
  if (await findWorkloadOccupant(username, jobId)) return
  if (!getAppContext().runtimeRegistry.tryStartJobPlanning(jobId, username)) return

  const planningDraft = ensureDraftPlanningAbilities(draft, coreCode as SupportedCoreCode)
  plannerSandboxDebug('runJob: start', {
    jobId,
    threadId,
    workspacePath,
    coreCode,
    inferredAbilities: planningDraft.abilities.length > draft.abilities.length
  })

  let planCommitted = false

  try {
    plannerSandboxDebug('runJob: resolving planner core')
    const plannerCoreCode = await resolvePlannerCoreCode(coreCode)
    plannerSandboxDebug('runJob: ensureCoreAvailable', { plannerCoreCode })
    const core = await ensureCoreAvailable(plannerCoreCode)
    const runtimeRoot = ensureRuntimeRoot(
      getAppContext().dataDir,
      threadId,
      core.code as SupportedCoreCode
    )
    const model = resolveCoreModel(core.code as SupportedCoreCode)
    plannerSandboxDebug('runJob: runtime prepared', {
      plannerCoreCode: core.code,
      runtimeRoot,
      model
    })

    const mcpSessionId = `plan-mcp-${randomUUID()}`
    const turnAbort = new AbortController()
    const referenceManifest = await loadJobReferenceManifest(jobId)

    const plannerSession: PlannerMcpSession = {
      sessionId: mcpSessionId,
      jobId,
      threadId,
      allowedAbilityCodes: planningDraft.abilities.map((ability) => ability.abilityCode),
      validReferenceIds:
        referenceManifest?.references.map((item) => item.id) ??
        planningDraft.references.map((item) => item.id),
      referenceManifest,
      taskContexts: new Map(),
      registeredPlan: null,
      onTaskContextRegistered: (_key, done) => {
        const partial = plannerSession.registeredPlan
          ? flattenRegisteredPlan(plannerSession.registeredPlan, plannerSession.taskContexts)
          : buildPartialPlanFromContexts(plannerSession.taskContexts)
        void pushPlanningProgress(jobId, done, partial, plannerSession.registeredPlan)
      },
      onPlanRegistered: (counts) => {
        if (!plannerSession.registeredPlan) return
        const saved = flattenRegisteredPlan(
          plannerSession.registeredPlan,
          plannerSession.taskContexts
        )
        void commitPlanReady(jobId, username, saved, counts).then((ok) => {
          if (!ok) return
          planCommitted = true
          plannerSandboxDebug('runJob: plan committed on register_plan', {
            jobId,
            tasks: counts.tasks
          })
          turnAbort.abort()
        })
      }
    }

    registerPlannerMcpSession(plannerSession)
    plannerSandboxDebug('runJob: planner MCP session registered', { mcpSessionId, jobId })

    let mcpUrl: string | undefined
    try {
      mcpUrl = buildPlannerMcpUrl({ sessionId: mcpSessionId, jobId })
    } catch {
      mcpUrl = undefined
    }
    plannerSandboxDebug('runJob: entering streamAgentTurn (planner, no outer sandbox)', {
      mcpUrl: mcpUrl ?? null,
      promptChars: buildPlannerUserMessage({ draft: planningDraft, workspacePath, threadId }).length
    })

    const plannerReadRoots = referenceManifest
      ? resolveReferenceManifestReadRoots({
          workspaceRoot: workspacePath,
          manifest: referenceManifest
        })
      : resolveDraftReferenceReadRoots({ threadId, draft: planningDraft })

    try {
      let chunkCount = 0
      for await (const chunk of streamAgentTurn({
        role: 'planner',
        provider: core.code as SupportedCoreCode,
        workspaceRoot: workspacePath,
        runtimeRoot,
        prompt: buildPlannerUserMessage({ draft: planningDraft, workspacePath, threadId }),
        model,
        systemPrompt: resolvePlannerPromptBody(),
        mcpUrl,
        readRoots: plannerReadRoots.length > 0 ? plannerReadRoots : undefined,
        signal: turnAbort.signal
      })) {
        chunkCount += 1
        if (chunkCount <= 5 || chunk.type === 'completed') {
          plannerSandboxDebug('runJob: planner chunk', {
            chunkCount,
            type: chunk.type
          })
        }
        if (chunk.type === 'completed') {
          break
        }
      }
      plannerSandboxDebug('runJob: streamAgentTurn finished', { chunkCount })
    } finally {
      unregisterPlannerMcpSession(mcpSessionId)
      plannerSandboxDebug('runJob: planner MCP session unregistered', { mcpSessionId })
    }

    if (planCommitted) {
      plannerSandboxDebug('runJob: finished after early plan commit', { jobId })
      return
    }

    const session = plannerSession
    if (!session.registeredPlan) {
      throw createTurnError('draft.plan_not_ready', {
        detail: 'Planner did not register a structured plan via register_plan'
      })
    }

    const savedPlan = flattenRegisteredPlan(session.registeredPlan, session.taskContexts)
    const counts = countPlanUnits(session.registeredPlan)
    await commitPlanReady(jobId, username, savedPlan, counts)
  } catch (error) {
    if (planCommitted) {
      plannerSandboxDebug('runJob: sandbox ended after plan committed (ignored)', { jobId })
      return
    }
    const current = await getUserJob(username, jobId)
    if (current?.status === 'paused' || current?.status === 'cancelled') {
      plannerSandboxDebug('runJob: stopped by user', { jobId, status: current.status })
      return
    }
    const failure = planFailureFromSandboxError(error)
    plannerSandboxDebug('runJob: failed', {
      jobId,
      message: failure.lastError.message,
      code: failure.lastError.code,
      phase: failure.planProgress.phase,
      stack: error instanceof Error ? error.stack : undefined
    })
    const job = await updateJobRow(jobId, {
      status: 'failed',
      planProgress: failure.planProgress,
      lastError: failure.lastError
    })
    if (job) {
      emitJobEvent(jobId, { event: 'plan_progress', data: { planProgress: failure.planProgress } })
      emitJobEvent(jobId, { event: 'error', data: { error: failure.lastError } })
      emitJobEvent(jobId, { event: 'job_done', data: { job } })
    }
  } finally {
    getAppContext().runtimeRegistry.endJobPlanning(jobId)
    plannerSandboxDebug('runJob: done', { jobId })
    const { advanceJobQueue } = await import('./job-queue')
    await advanceJobQueue(username)
  }
}

export function scheduleJobPlanning(
  username: string,
  threadId: string,
  jobId: string,
  draft: TaskLaunchDraftPayload,
  workspacePath: string,
  coreCode: string
): void {
  void runJob(username, threadId, jobId, draft, workspacePath, coreCode)
}

export async function retryJobPlanning(username: string, jobId: string): Promise<ThreadJobDto> {
  if (isDesignSessionId(jobId)) {
    const { retryDesignSessionPlanning } = await import('../design-session/planner')
    return retryDesignSessionPlanning(username, jobId)
  }

  const job = await getUserJob(username, jobId)
  if (!job) throw AppError.notFound('Job not found', 'job.not_found')
  if (!['failed', 'cancelled', 'paused', 'plan_editing', 'planning'].includes(job.status)) {
    throw AppError.badRequest('Job status does not allow replanning', 'job.invalid_status', {
      status: job.status
    })
  }

  const message = await getMessage(username, job.threadId, job.draftMessageId, {
    signAssets: false
  })
  if (!message || message.kind !== 'task-launch-draft') {
    throw AppError.badRequest('Original task draft not found', 'draft.not_found')
  }
  const payload = message.payload as TaskLaunchDraftPayload | undefined
  if (!payload?.draftId) {
    throw AppError.badRequest('Draft payload invalid', 'draft.invalid_payload')
  }

  const row = await getThreadRow(username, job.threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')
  const project = await getProject(username, row.projectId)
  if (!project) throw AppError.notFound('Project not found', 'project.not_found')

  const planProgress: PlanProgressDto = {
    ...defaultPlanProgress(),
    phase: 'planning',
    status: 'running',
    progressCode: 'plan.regenerating',
    progressParams: null,
    message: null
  }
  const taskProgress = defaultTaskProgress()

  const updated = await updateJobRow(jobId, {
    status: 'planning',
    plan: null,
    planProgress,
    taskProgress,
    lastError: null
  })
  if (!updated) throw AppError.internal('Failed to retry planning', 'turn.unknown')

  emitJobEvent(jobId, { event: 'plan_progress', data: { planProgress } })
  emitJobEvent(jobId, { event: 'task_progress', data: { taskProgress } })
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job: updated } })

  scheduleJobPlanning(username, job.threadId, jobId, payload, project.workspaceRoot, row.coreCode)
  return updated
}

async function pushPlanningProgress(
  jobId: string,
  done: number,
  partialPlan: SavedJobPlan,
  registeredPlan?: import('../planner/plan-types').PlannerRegisteredPlan | null
): Promise<void> {
  const structuredTotal = registeredPlan ? countPlanUnits(registeredPlan).tasks : 0
  const partialCount = partialPlan.tasks.length
  const total =
    structuredTotal > 0
      ? structuredTotal
      : partialCount > 0
        ? Math.max(partialCount + 1, done + 1)
        : 0
  const planProgress: PlanProgressDto = {
    phase: 'planning',
    status: 'running',
    contextsRegistered: done,
    contextsTotal: total,
    progressCode: 'plan.planning_partial',
    progressParams:
      structuredTotal > 0 ? { done, total: structuredTotal } : done > 0 ? { done } : undefined,
    message: null
  }

  const db = getDb()
  await saveJobPlan(db, jobId, partialPlan)
  await savePlanProgress(db, jobId, planProgress)
  await db.update(threadJobs).set({ updatedAt: nowSec() }).where(eq(threadJobs.id, jobId))

  const rows = await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1)
  const job = rows[0] ? await mapJob(rows[0], { includePlan: true }) : null
  if (!job) return

  emitJobEvent(jobId, { event: 'plan_progress', data: { planProgress, plan: partialPlan } })
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job } })
}

function shouldCloseJobStream(status: string): boolean {
  return (
    status === 'plan_editing' ||
    status === 'plan_ready' ||
    status === 'paused' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled'
  )
}

export async function* streamJobEvents(
  username: string,
  threadId: string,
  jobId: string
): AsyncGenerator<JobSseEvent> {
  const job = await getThreadJob(username, threadId, jobId)
  if (!job) {
    throw AppError.notFound('Job not found', 'job.not_found')
  }

  yield { event: 'job_snapshot', data: { job } }
  yield { event: 'plan_progress', data: { planProgress: job.planProgress } }
  yield { event: 'task_progress', data: { taskProgress: job.taskProgress } }

  if (shouldCloseJobStream(job.status)) {
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      yield { event: 'job_done', data: { job } }
    }
    return
  }

  const queue: JobSseEvent[] = []
  let resolveWait: (() => void) | null = null

  const unsubscribe = subscribeJobEvents(jobId, (event) => {
    enqueueJobSseEvent(queue, event)
    resolveWait?.()
    resolveWait = null
  })

  try {
    while (true) {
      while (queue.length > 0) {
        const event = queue.shift()!
        yield event
        if (event.event === 'job_done' || event.event === 'error') {
          const latest = await getThreadJob(username, threadId, jobId)
          if (latest && shouldCloseJobStream(latest.status)) {
            return
          }
        }
      }

      const latest = await getThreadJob(username, threadId, jobId)
      if (latest && shouldCloseJobStream(latest.status)) {
        if (
          latest.status === 'completed' ||
          latest.status === 'failed' ||
          latest.status === 'cancelled'
        ) {
          yield { event: 'job_done', data: { job: latest } }
        }
        return
      }

      await new Promise<void>((resolve) => {
        resolveWait = resolve
        setTimeout(resolve, 15000)
      })
    }
  } finally {
    unsubscribe()
  }
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
