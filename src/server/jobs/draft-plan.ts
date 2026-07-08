import { randomUUID } from 'crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { AppError } from '../error'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { designSessions, projects, threadMessages, threads } from '../db/schema'
import type { ConversationMessageDto } from '../conversation/types'
import type { PlanProgressDto, ThreadJobDto } from './types'
import type { TaskLaunchDraftPayload } from '../conversation/draft/types'
import type { SupportedCoreCode } from '../conversation/cores'
import {
  draftPayloadToClientJson,
  ensureDraftPlanningAbilities,
  buildUnlockedDraftPayload,
  buildUnlockedRequirementsContractPayload,
  syncRequirementsContractFromDraft
} from '../conversation/draft/normalize'
import {
  isDraftEditable,
  isDraftSectionLocked,
  normalizeDraftStatus
} from '../conversation/draft/status'
import { getMessage, listMessages, updateMessagePayload } from '../conversation/messages'
import { getThreadRow } from '../threads/service'
import { THREAD_KIND_CREATE_TASK } from '../threads/types'
import { getProject } from '../projects/service'
import { defaultPlanProgress, defaultTaskProgress } from '../planner/save-plan'
import type { SavedJobPlan } from '../planner/plan-types'
import { collectMissingReferenceDescriptions } from '@shared/draft-references'
import { validateTaskReferenceIds } from '@shared/job-references'
import { isDraftListEntryLaunched } from '@shared/job-lifecycle'
import { mergeDraftReferences } from './draft-references'
import {
  buildManifestFromCorpus,
  listReferenceCorpus,
  syncCorpusFromDraftPayload,
  assertCorpusDescriptionsReady
} from '../reference-corpus/service'
import {
  loadJobReferenceManifest,
  ReferenceFileMissingError,
  serializeJobReferenceManifest
} from './reference-manifest'
import { resolvePlanNode } from './plan-node-ref'
import { isPlanFullyConfirmed } from '@shared/plan-mutations'
import {
  advanceWizardPhase,
  assertActiveDraft,
  assertActivePlan,
  assertThreadWizardPhase,
  buildDraftToPlanHandoff,
  buildPlanPhaseHandoff,
  buildRollbackHandoff,
  resolveWizardPhase
} from '../wizard/phase'
import { isDraftWorkspaceLocked } from '../wizard/edit-guard'
import { isCollectingDraftPayload } from '../conversation/draft/collecting'
import {
  WIZARD_PHASE_DRAFT_REVIEW,
  WIZARD_PHASE_PLAN_EDIT,
  WIZARD_PHASE_PLAN_GENERATING,
  WIZARD_PHASE_READY_TO_LAUNCH
} from '../wizard/types'
import { emitJobEvent, getThreadJob, updateJobRow } from './service'
import {
  getDesignSessionAsJob,
  getDesignSessionRow,
  isDesignSessionId,
  launchJobFromDesignSession,
  listThreadDesignSessions,
  updateDesignSessionRow
} from '../design-session/service'
import { scheduleDesignSessionPlanning } from '../design-session/planner'
import {
  saveDesignAbilities,
  saveDesignPlan,
  saveDesignPlanProgress,
  loadDesignPlan
} from '../db/design-plan'

function resolveDraftSummaryLinkedPlanId(
  payload: Pick<TaskLaunchDraftPayload, 'linkedPlanId' | 'status'>,
  planRow: { id: string } | undefined
): string | null {
  const explicit = payload.linkedPlanId?.trim()
  if (explicit) return explicit
  if (isDraftEditable(payload)) return null
  return planRow?.id ?? null
}

export { TASK_LIST_JOB_STATUSES } from './constants'

function resolveDraftDesignSessionId(
  planRow: { id: string } | undefined,
  payload: Pick<TaskLaunchDraftPayload, 'linkedPlanId'> & { designSessionId?: string | null }
): string | null {
  if (planRow?.id) return planRow.id
  const fromPayload = payload.designSessionId?.trim()
  if (fromPayload && isDesignSessionId(fromPayload)) return fromPayload
  const linked = payload.linkedPlanId?.trim()
  if (linked && isDesignSessionId(linked)) return linked
  return null
}

function resolveDraftLaunchedJobId(
  planRow: { launchedJobId: string | null } | undefined,
  linkedPlanId: string | null
): string | null {
  if (planRow?.launchedJobId) return planRow.launchedJobId
  if (linkedPlanId && !isDesignSessionId(linkedPlanId)) return linkedPlanId
  return null
}

export interface ThreadDraftSummary {
  messageId: string
  draftId: string
  title: string
  summary: string
  status: string
  linkedPlanId: string | null
  designSessionId: string | null
  launchedJobId: string | null
  createdAt: string
  collecting?: boolean
  plan?: {
    id: string
    status: string
    title: string
  } | null
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function assertDraftReferencesReady(payload: TaskLaunchDraftPayload): void {
  const refs = mergeDraftReferences(payload)
  const missing = collectMissingReferenceDescriptions(refs)
  if (missing.length > 0) {
    throw AppError.badRequest(
      'Reference descriptions required',
      'draft.reference_description_missing',
      { references: missing.slice(0, 5).join(', '), count: missing.length }
    )
  }
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
    status: normalizeDraftStatus(payload.status),
    lockedSections: payload.lockedSections ?? {},
    abilities: payload.abilities ?? [],
    references: payload.references ?? [],
    sourceAttachments: payload.sourceAttachments ?? []
  }
}

async function persistDraftPayload(
  username: string,
  threadId: string,
  messageId: string,
  payload: TaskLaunchDraftPayload,
  options?: { expectedRevision?: number }
): Promise<{
  messageId: string
  payload: Record<string, unknown>
  message: ConversationMessageDto
}> {
  if (options?.expectedRevision != null && (payload.revision ?? 0) !== options.expectedRevision) {
    throw AppError.badRequest('Draft revision conflict', 'draft.conflict', {
      expectedRevision: options.expectedRevision,
      currentRevision: payload.revision ?? 0
    })
  }
  const next: TaskLaunchDraftPayload = {
    ...payload,
    revision: (payload.revision ?? 0) + 1
  }
  const updated = await updateMessagePayload(
    username,
    threadId,
    messageId,
    draftPayloadToClientJson(next)
  )
  if (!updated?.payload) {
    throw AppError.internal('Failed to update draft', 'turn.unknown')
  }
  return { messageId, payload: updated.payload as Record<string, unknown>, message: updated }
}

export async function resolveDraftMessageId(
  username: string,
  threadId: string,
  input: { messageId?: string; draftId?: string; activeDraftId?: string | null }
): Promise<string> {
  const messageId = input.messageId?.trim() ?? ''
  if (messageId) return messageId

  const draftId = input.draftId?.trim() ?? ''
  const messages = await listMessages(username, threadId, 200, { signAssets: false })
  const drafts = messages.filter((m) => m.kind === 'task-launch-draft')
  if (draftId) {
    const match = drafts.find((m) => (m.payload as TaskLaunchDraftPayload)?.draftId === draftId)
    if (match) return match.id
  }
  if (input.activeDraftId) {
    const match = drafts.find((m) => m.id === input.activeDraftId)
    if (match) return match.id
  }
  if (drafts.length === 1) return drafts[0].id
  throw AppError.badRequest(
    'Specify draftId, messageId, or select a draft in the UI',
    'draft.not_found'
  )
}

function applyTextReplacements(
  text: string,
  replacements: Array<{ find: string; replace: string }>
): string {
  let result = text
  for (const item of replacements) {
    const find = item.find
    if (!find) continue
    result = result.split(find).join(item.replace)
  }
  return result
}

export async function getTaskDraftSnapshot(
  username: string,
  threadId: string,
  messageId: string
): Promise<Record<string, unknown>> {
  const { phase } = await assertThreadWizardPhase(username, threadId, [
    WIZARD_PHASE_DRAFT_REVIEW,
    WIZARD_PHASE_PLAN_EDIT
  ])
  await assertActiveDraft(username, threadId, messageId)
  const payload = await loadDraftPayload(username, threadId, messageId)
  const references = mergeDraftReferences(payload).map((ref) => ({
    id: ref.id,
    name: ref.name,
    kind: ref.kind,
    mimeType: ref.mimeType,
    description: ref.description ?? '',
    assetUrl: ref.assetUrl
  }))

  const row = await getThreadRow(username, threadId)
  const draftLocked = row ? isDraftWorkspaceLocked(payload, row) : false

  const workflowHint = draftLocked
    ? 'Draft is locked because an execution plan exists. Unlock the draft in the Web UI to edit and regenerate the plan.'
    : phase === WIZARD_PHASE_PLAN_EDIT
      ? 'Read-only draft context for execution tree review. Call get_execution_plan for the current tree, then update_execution_plan_node to edit nodes.'
      : 'To edit the contract: call revise_requirements_contract with revision from this snapshot (read-modify-write), or update_task_draft with the same revision.'

  return {
    messageId,
    draftId: payload.draftId,
    revision: payload.revision ?? 0,
    editable: isDraftEditable(payload) && !draftLocked,
    draftLocked,
    unlockRequired: draftLocked,
    lockedSections: payload.lockedSections ?? {},
    linkedPlanId: payload.linkedPlanId ?? null,
    title: payload.title,
    summary: payload.summary,
    userFlow: payload.userFlow,
    techStack: payload.techStack,
    nfr: payload.nfr,
    acceptance: payload.acceptance,
    outOfScope: payload.outOfScope,
    assumptions: payload.assumptions,
    references,
    requirementsContract: {
      status: payload.requirementsContract.status,
      markdown: payload.requirementsContract.markdown,
      confirmedAt: payload.requirementsContract.confirmedAt ?? null
    },
    abilities: payload.abilities.map((a) => ({
      abilityCode: a.abilityCode,
      label: a.label,
      recommendedCoreCode: a.recommendedCoreCode
    })),
    workflowHint
  }
}

export async function resolveJobId(
  username: string,
  threadId: string,
  input: { jobId?: string; activePlanId?: string | null }
): Promise<string> {
  const jobId = input.jobId?.trim() ?? ''
  if (jobId) return jobId

  if (input.activePlanId) return input.activePlanId

  const plans = await listThreadPlans(username, threadId)
  if (plans.length === 1) return plans[0].id
  throw AppError.badRequest(
    'Specify jobId, designSessionId, or select a plan in the UI',
    'job.not_found'
  )
}

export async function getExecutionPlanSnapshot(
  username: string,
  threadId: string,
  planOrSessionId: string
): Promise<Record<string, unknown>> {
  await assertThreadWizardPhase(username, threadId, [
    WIZARD_PHASE_PLAN_EDIT,
    WIZARD_PHASE_READY_TO_LAUNCH
  ])
  await assertActivePlan(username, threadId, planOrSessionId)

  if (isDesignSessionId(planOrSessionId)) {
    const job = await getDesignSessionAsJob(username, threadId, planOrSessionId)
    if (!job) throw AppError.notFound('Design session not found', 'job.not_found')
    const sessionRow = await getDesignSessionRow(planOrSessionId)
    return buildExecutionPlanSnapshotFromJob(job, sessionRow?.planRevision ?? 0)
  }

  const job = await getThreadJob(username, threadId, planOrSessionId)
  if (!job) throw AppError.notFound('Plan not found', 'job.not_found')
  return buildExecutionPlanSnapshotFromJob(job, 0)
}

function buildExecutionPlanSnapshotFromJob(
  job: ThreadJobDto,
  planRevision: number
): Record<string, unknown> {
  const plan = job.plan
  if (!plan?.milestones?.length) {
    return {
      jobId: job.id,
      designSessionId: isDesignSessionId(job.id) ? job.id : undefined,
      planRevision,
      draftMessageId: job.draftMessageId,
      title: job.title,
      summary: job.summary,
      status: job.status,
      editable: job.status === 'plan_editing',
      planReady: false,
      planProgress: job.planProgress,
      abilities: job.abilities,
      references: (job.referenceManifest?.references ?? []).map((ref) => ({
        id: ref.id,
        name: ref.name,
        kind: ref.kind,
        mimeType: ref.mimeType,
        description: ref.description,
        requiresDescription: ref.requiresDescription
      })),
      progressCode: 'plan.tree_not_ready',
      message: null,
      workflowHint:
        'Planning is still running. Retry get_execution_plan after planProgress shows completion. Use get_task_draft for REQUIREMENTS CONTRACT context.'
    }
  }

  const flatById = new Map((plan.tasks ?? []).map((task) => [task.id, task]))

  const milestones = plan.milestones.map((milestone, mi) => {
    const mRef = `m${mi + 1}`
    const slices = (milestone.slices ?? []).map((slice, si) => {
      const sRef = `${mRef}-s${si + 1}`
      const tasks = (slice.tasks ?? []).map((_task, ti) => {
        const nodeRef = `${sRef}-t${ti + 1}`
        const flat = flatById.get(nodeRef)
        return {
          nodeRef,
          title: flat?.title ?? _task.title ?? nodeRef,
          description: flat?.description ?? _task.description ?? '',
          successCriteria: flat?.successCriteria ?? _task.successCriteria ?? '',
          taskKind: flat?.taskKind ?? _task.taskKind ?? '',
          abilityCode: flat?.abilityCode ?? _task.abilityCode ?? '',
          coreCode: flat?.coreCode ?? null,
          contextMarkdown: flat?.contextMarkdown ?? '',
          referenceIds: flat?.referenceIds ?? _task.referenceIds,
          referenceReason: flat?.referenceReason ?? _task.referenceReason,
          confirmed: Boolean(flat?.confirmed ?? _task.confirmed),
          dependsOnTaskRefs: flat?.dependsOnTaskRefs ?? _task.dependsOnTaskRefs,
          canRunInParallel: flat?.canRunInParallel ?? _task.canRunInParallel
        }
      })
      return {
        nodeRef: sRef,
        title: slice.title ?? `Slice ${si + 1}`,
        description: slice.description ?? '',
        successCriteria: slice.successCriteria ?? '',
        confirmed: Boolean(slice.confirmed),
        tasks
      }
    })
    return {
      nodeRef: mRef,
      title: milestone.title ?? `Milestone ${mi + 1}`,
      description: milestone.description ?? '',
      successCriteria: milestone.successCriteria ?? '',
      confirmed: Boolean(milestone.confirmed),
      slices
    }
  })

  return {
    jobId: job.id,
    designSessionId: isDesignSessionId(job.id) ? job.id : undefined,
    planRevision,
    draftMessageId: job.draftMessageId,
    title: job.title,
    summary: job.summary,
    status: job.status,
    editable: job.status === 'plan_editing',
    planReady: true,
    planProgress: job.planProgress,
    abilities: job.abilities,
    references: (job.referenceManifest?.references ?? []).map((ref) => ({
      id: ref.id,
      name: ref.name,
      kind: ref.kind,
      mimeType: ref.mimeType,
      description: ref.description,
      requiresDescription: ref.requiresDescription
    })),
    milestones,
    workflowHint:
      'Call get_task_draft for REQUIREMENTS CONTRACT. For small edits use update_execution_plan_node. For full tree replacement use replace_execution_plan with expectedPlanRevision from this snapshot. For complex reordering use request_plan_regeneration. All mutations clear confirmed flags.'
  }
}

export async function reviseRequirementsContract(
  username: string,
  threadId: string,
  messageId: string,
  input: {
    revision: number
    replacements?: Array<{ find: string; replace: string }>
    requirementsContractMarkdown?: string
    syncStructuredFields?: boolean
  }
): Promise<{
  messageId: string
  payload: Record<string, unknown>
  message: ConversationMessageDto
  draftRevision: number
  requirementsContractMarkdown: string
}> {
  await assertThreadWizardPhase(username, threadId, WIZARD_PHASE_DRAFT_REVIEW)
  const payload = await loadDraftPayload(username, threadId, messageId)
  await assertActiveDraft(username, threadId, messageId, input.revision)
  if (!isDraftEditable(payload)) {
    throw AppError.badRequest('Draft is already confirmed', 'draft.locked', { reason: 'confirmed' })
  }
  if (isDraftSectionLocked(payload, 'requirementsContract')) {
    throw AppError.badRequest('Requirements contract is locked', 'draft.locked', {
      section: 'requirementsContract'
    })
  }

  const replacements = input.replacements?.filter((item) => item.find) ?? []
  const explicitMarkdown = input.requirementsContractMarkdown?.trim()
  if (replacements.length === 0 && !explicitMarkdown) {
    throw AppError.badRequest(
      'Provide replacements or requirementsContractMarkdown',
      'draft.invalid_payload'
    )
  }

  let contractMarkdown = payload.requirementsContract.markdown
  if (replacements.length > 0) {
    contractMarkdown = applyTextReplacements(contractMarkdown, replacements)
  } else if (explicitMarkdown) {
    contractMarkdown = explicitMarkdown
  }

  const syncStructured = input.syncStructuredFields !== false && replacements.length > 0
  const patch: Parameters<typeof updateDraftContent>[3] = {
    revision: input.revision,
    requirementsContractMarkdown: contractMarkdown
  }
  if (syncStructured) {
    patch.title = applyTextReplacements(payload.title, replacements)
    patch.summary = applyTextReplacements(payload.summary, replacements)
    patch.userFlow = applyTextReplacements(payload.userFlow, replacements)
    patch.techStack = applyTextReplacements(payload.techStack, replacements)
  }

  const result = await updateDraftContent(username, threadId, messageId, patch)
  return {
    messageId: result.messageId,
    payload: result.payload,
    message: result.message,
    draftRevision: (result.payload as { revision?: number }).revision ?? 0,
    requirementsContractMarkdown: contractMarkdown
  }
}

export async function listThreadDrafts(
  username: string,
  threadId: string
): Promise<ThreadDraftSummary[]> {
  const messages = await listMessages(username, threadId, 500, { signAssets: false })
  const drafts = messages.filter((msg) => msg.kind === 'task-launch-draft')
  const db = getDb()
  const designRows = await db
    .select()
    .from(designSessions)
    .where(and(eq(designSessions.threadId, threadId), eq(designSessions.username, username)))
    .orderBy(desc(designSessions.updatedAt))

  const planByDraftId = new Map(designRows.map((row) => [row.draftMessageId, row]))

  return drafts.map((msg) => {
    const payload = (msg.payload ?? {}) as TaskLaunchDraftPayload & {
      designSessionId?: string | null
    }
    const planRow = planByDraftId.get(msg.id)
    const linkedPlanId = resolveDraftSummaryLinkedPlanId(payload, planRow)
    const designSessionId = resolveDraftDesignSessionId(planRow, payload)
    const launchedJobId = resolveDraftLaunchedJobId(planRow, linkedPlanId)
    return {
      messageId: msg.id,
      draftId: payload.draftId ?? msg.id,
      title: payload.title ?? msg.content.split('\n')[0] ?? 'Draft',
      summary: payload.summary ?? '',
      status: normalizeDraftStatus(payload.status),
      linkedPlanId,
      designSessionId,
      launchedJobId,
      createdAt: msg.createdAt,
      collecting: isCollectingDraftPayload(payload),
      plan:
        designSessionId && planRow
          ? {
              id: planRow.id,
              status: planRow.status,
              title: planRow.title
            }
          : null
    }
  })
}

export interface UserDraftListEntry {
  messageId: string
  draftId: string
  title: string
  summary: string
  status: string
  linkedPlanId: string | null
  createdAt: string
  plan: { id: string; status: string; title: string } | null
  threadId: string
  projectId: string
  projectTitle: string
  threadTitle: string
  launched: boolean
  jobId: string | null
  collecting?: boolean
}

export async function listUserDrafts(
  username: string,
  options?: { q?: string; completion?: 'all' | 'incomplete' | 'complete' }
): Promise<UserDraftListEntry[]> {
  const db = getDb()
  const rows = await db
    .select({
      messageId: threadMessages.id,
      content: threadMessages.content,
      payloadJson: threadMessages.payloadJson,
      createdAt: threadMessages.createdAt,
      threadId: threads.id,
      threadTitle: threads.title,
      projectId: projects.id,
      projectTitle: projects.title
    })
    .from(threadMessages)
    .innerJoin(threads, eq(threadMessages.threadId, threads.id))
    .innerJoin(projects, eq(threads.projectId, projects.id))
    .where(
      and(
        eq(threads.username, username),
        eq(threads.threadKind, THREAD_KIND_CREATE_TASK),
        eq(threadMessages.kind, 'task-launch-draft')
      )
    )
    .orderBy(desc(threadMessages.createdAt))

  const threadIds = [...new Set(rows.map((row) => row.threadId))]
  const designRows =
    threadIds.length === 0
      ? []
      : await db
          .select()
          .from(designSessions)
          .where(
            and(eq(designSessions.username, username), inArray(designSessions.threadId, threadIds))
          )

  const planByDraftId = new Map(designRows.map((row) => [row.draftMessageId, row]))

  let entries: UserDraftListEntry[] = []
  for (const row of rows) {
    const payload = parseJson<Partial<TaskLaunchDraftPayload>>(row.payloadJson, {})
    const status = normalizeDraftStatus(payload.status)
    if (status === 'archived') continue
    const planRow = planByDraftId.get(row.messageId)
    const designSessionId = resolveDraftSummaryLinkedPlanId(
      { linkedPlanId: payload.linkedPlanId ?? null, status },
      planRow
    )
    const plan =
      designSessionId && planRow
        ? { id: planRow.id, status: planRow.status, title: planRow.title }
        : null
    const launched = isDraftListEntryLaunched({
      planStatus: planRow?.status ?? plan?.status,
      hasLaunchedJobId: Boolean(planRow?.launchedJobId)
    })
    const jobId = planRow?.launchedJobId ?? (launched ? designSessionId : null)
    entries.push({
      messageId: row.messageId,
      draftId: payload.draftId ?? row.messageId,
      title: payload.title ?? row.content.split('\n')[0] ?? 'Draft',
      summary: payload.summary ?? '',
      status,
      linkedPlanId: designSessionId,
      createdAt: row.createdAt,
      plan,
      threadId: row.threadId,
      projectId: row.projectId,
      projectTitle: row.projectTitle,
      threadTitle: row.threadTitle,
      launched,
      jobId,
      collecting: isCollectingDraftPayload(payload)
    })
  }

  const completion = options?.completion ?? 'all'
  if (completion === 'complete') entries = entries.filter((entry) => entry.launched)
  if (completion === 'incomplete') entries = entries.filter((entry) => !entry.launched)

  const q = options?.q?.trim().toLowerCase()
  if (q) {
    entries = entries.filter((entry) => {
      const haystack = [entry.title, entry.summary, entry.projectTitle, entry.threadTitle]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }

  return entries
}

export async function listThreadPlans(username: string, threadId: string): Promise<ThreadJobDto[]> {
  return listThreadDesignSessions(username, threadId)
}

async function recoverStuckDraftPlanningHandoff(
  username: string,
  threadId: string,
  draftMessageId: string,
  payload: TaskLaunchDraftPayload
): Promise<{ job: ThreadJobDto; draft: ConversationMessageDto } | null> {
  if (isDraftEditable(payload) || !payload.linkedPlanId) return null
  if (!isDesignSessionId(payload.linkedPlanId)) return null

  const row = await getThreadRow(username, threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')

  const job = await getDesignSessionAsJob(username, threadId, payload.linkedPlanId)
  if (!job) return null

  const message = await getMessage(username, threadId, draftMessageId)
  if (!message) throw AppError.notFound('Draft message not found', 'draft.not_found')

  const phase = resolveWizardPhase(row)
  if (phase === WIZARD_PHASE_PLAN_EDIT && row.activePlanId === payload.linkedPlanId) {
    return { job, draft: message }
  }
  if (phase !== WIZARD_PHASE_DRAFT_REVIEW) return null

  await advanceWizardPhase(username, threadId, {
    to: WIZARD_PHASE_PLAN_EDIT,
    coreCode: row.coreCode,
    activeDraftId: draftMessageId,
    activePlanId: payload.linkedPlanId,
    handoff: buildDraftToPlanHandoff({
      draftMessageId,
      draftRevision: payload.revision ?? 1,
      planId: payload.linkedPlanId,
      payload
    })
  })

  return { job, draft: message }
}

async function findDesignSessionForDraft(
  threadId: string,
  draftMessageId: string
): Promise<typeof designSessions.$inferSelect | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(designSessions)
    .where(
      and(eq(designSessions.threadId, threadId), eq(designSessions.draftMessageId, draftMessageId))
    )
    .limit(1)
  return rows[0] ?? null
}

export async function confirmDraftAndStartPlanning(
  username: string,
  threadId: string,
  draftMessageId: string
): Promise<{ job: ThreadJobDto; draft: ConversationMessageDto }> {
  const { ensureStartupWorkloadReady } = await import('./workload-slot')
  const { reconcileOrphanWorkloadSlotsForUser, reconcileUserPlanningState } =
    await import('./reconcile')
  await ensureStartupWorkloadReady()
  await reconcileOrphanWorkloadSlotsForUser(username)
  await reconcileUserPlanningState(username)

  await assertThreadWizardPhase(username, threadId, WIZARD_PHASE_DRAFT_REVIEW)
  await assertActiveDraft(username, threadId, draftMessageId)

  const payload = await loadDraftPayload(username, threadId, draftMessageId)
  const recovered = await recoverStuckDraftPlanningHandoff(
    username,
    threadId,
    draftMessageId,
    payload
  )
  if (recovered) return recovered

  if (!isDraftEditable(payload)) {
    throw AppError.badRequest('Draft is already confirmed', 'draft.locked', { reason: 'confirmed' })
  }
  if (payload.requirementsContract.status !== 'confirmed') {
    throw AppError.badRequest(
      'Confirm the requirements contract first',
      'draft.requirements_contract_not_confirmed'
    )
  }
  assertDraftReferencesReady(payload)

  const row = await getThreadRow(username, threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')

  const payloadWithAbilities = ensureDraftPlanningAbilities(
    payload,
    row.coreCode as SupportedCoreCode
  )
  if (payloadWithAbilities.abilities.some((a) => !a.recommendedCoreCode)) {
    throw AppError.badRequest(
      'Select an execution CLI for every ability',
      'draft.abilities_core_missing'
    )
  }
  const project = await getProject(username, row.projectId)
  if (!project) throw AppError.notFound('Project not found', 'project.not_found')

  const confirmedAt = nowSec()
  const planProgress: PlanProgressDto = {
    ...defaultPlanProgress(),
    phase: 'planning',
    status: 'running',
    progressCode: 'plan.planning',
    message: null
  }
  const taskProgress = defaultTaskProgress()
  const db = getDb()

  const existingSession = await findDesignSessionForDraft(threadId, draftMessageId)
  if (existingSession?.launchedJobId) {
    throw AppError.badRequest('Job already launched', 'job.already_launched')
  }

  const designSessionId = existingSession?.id ?? `ds-${randomUUID()}`
  const sessionValues = {
    threadId,
    username,
    draftMessageId,
    title: payloadWithAbilities.title,
    summary: payloadWithAbilities.summary ?? '',
    workspaceRoot: project.workspaceRoot,
    phase: 'plan_generating',
    draftRevision: payloadWithAbilities.revision ?? 0,
    planRevision: 0,
    status: 'planning',
    planPhase: planProgress.phase,
    planStatus: planProgress.status,
    planContextsRegistered: planProgress.contextsRegistered,
    planContextsTotal: planProgress.contextsTotal,
    planMessage: planProgress.message ?? null,
    planCountsJson: '{}',
    taskPhase: taskProgress.phase,
    taskStatus: taskProgress.status,
    taskCurrentIndex: taskProgress.currentIndex,
    taskTotal: taskProgress.total,
    taskCurrentTaskId: taskProgress.currentTaskId ?? null,
    taskMessage: taskProgress.message ?? null,
    taskMetaJson: '{}',
    referenceManifestJson: null,
    manifestRevision: 0,
    corpusRevision: 0,
    frozenCorpusRevision: 0,
    draftConfirmedAt: confirmedAt,
    launchedJobId: null,
    lastError: null,
    updatedAt: confirmedAt
  }

  if (existingSession) {
    await saveDesignPlan(db, designSessionId, EMPTY_SAVED_PLAN)
    await db.update(designSessions).set(sessionValues).where(eq(designSessions.id, designSessionId))
  } else {
    await db.insert(designSessions).values({
      id: designSessionId,
      ...sessionValues,
      createdAt: confirmedAt
    })
  }

  let referenceManifest
  try {
    await syncCorpusFromDraftPayload({ designSessionId, payload: payloadWithAbilities })
    const corpus = await listReferenceCorpus(designSessionId)
    assertCorpusDescriptionsReady(corpus)
    referenceManifest = buildManifestFromCorpus({
      designSessionId,
      draftMessageId,
      threadId,
      workspaceRoot: project.workspaceRoot,
      corpus,
      manifestRevision: 1
    })
  } catch (error) {
    await db.delete(designSessions).where(eq(designSessions.id, designSessionId))
    if (error instanceof ReferenceFileMissingError) {
      throw AppError.badRequest('Reference file missing', 'draft.reference_not_found', {
        referenceId: error.referenceId,
        referenceName: error.referenceName,
        path: error.relativePath
      })
    }
    throw error
  }

  await db
    .update(designSessions)
    .set({
      referenceManifestJson: serializeJobReferenceManifest(referenceManifest),
      manifestRevision: 1,
      corpusRevision: 1,
      frozenCorpusRevision: 1,
      updatedAt: confirmedAt
    })
    .where(eq(designSessions.id, designSessionId))

  await saveDesignAbilities(db, designSessionId, payloadWithAbilities.abilities)
  await saveDesignPlanProgress(db, designSessionId, planProgress)

  const confirmedPayload: TaskLaunchDraftPayload = {
    ...payloadWithAbilities,
    status: 'confirmed',
    linkedPlanId: designSessionId,
    requirementsContract: {
      ...payloadWithAbilities.requirementsContract,
      status: 'confirmed',
      confirmedAt: payloadWithAbilities.requirementsContract.confirmedAt ?? new Date().toISOString()
    }
  }
  const draftResult = await persistDraftPayload(
    username,
    threadId,
    draftMessageId,
    confirmedPayload
  )

  const job = await getDesignSessionAsJob(username, threadId, designSessionId)
  if (!job) throw AppError.internal('Failed to create design session', 'turn.unknown')

  scheduleDesignSessionPlanning(
    username,
    threadId,
    designSessionId,
    confirmedPayload,
    project.workspaceRoot,
    row.coreCode
  )

  await advanceWizardPhase(username, threadId, {
    to: WIZARD_PHASE_PLAN_GENERATING,
    coreCode: row.coreCode,
    activeDraftId: draftMessageId,
    activePlanId: designSessionId,
    handoff: buildDraftToPlanHandoff({
      draftMessageId,
      draftRevision: confirmedPayload.revision ?? 1,
      planId: designSessionId,
      payload: confirmedPayload
    })
  })

  return { job, draft: draftResult.message }
}

const EMPTY_SAVED_PLAN: SavedJobPlan = { milestones: [], tasks: [] }

export async function unlockDraftForEdit(
  username: string,
  threadId: string,
  draftMessageId: string
): Promise<{ draft: ConversationMessageDto; thread: import('../threads/types').ThreadDto }> {
  const row = await getThreadRow(username, threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')

  const phase = resolveWizardPhase(row)
  if (
    phase !== WIZARD_PHASE_PLAN_GENERATING &&
    phase !== WIZARD_PHASE_PLAN_EDIT &&
    phase !== WIZARD_PHASE_READY_TO_LAUNCH
  ) {
    throw AppError.badRequest('Draft is not locked', 'draft.not_locked')
  }

  await assertActiveDraft(username, threadId, draftMessageId)
  const payload = await loadDraftPayload(username, threadId, draftMessageId)

  const designSessionId = row.activePlanId?.trim() || payload.linkedPlanId?.trim() || ''
  if (!designSessionId || !isDesignSessionId(designSessionId)) {
    throw AppError.badRequest('No execution plan to unlock', 'draft.plan_not_ready')
  }

  const sessionRow = await getDesignSessionRow(designSessionId)
  if (sessionRow?.launchedJobId) {
    throw AppError.badRequest('Job already launched', 'job.already_launched')
  }

  getAppContext().runtimeRegistry.endJobPlanning(designSessionId)

  const cancelledProgress: PlanProgressDto = {
    ...defaultPlanProgress(),
    phase: 'idle',
    status: 'failed',
    progressCode: 'plan.draft_unlocked',
    message: null
  }

  await updateDesignSessionRow(designSessionId, {
    status: 'cancelled',
    phase: WIZARD_PHASE_DRAFT_REVIEW,
    planRevision: 0,
    plan: EMPTY_SAVED_PLAN,
    planProgress: cancelledProgress,
    lastError: null
  })

  const cancelledJob = await getDesignSessionAsJob(username, threadId, designSessionId)
  if (cancelledJob) {
    emitJobEvent(designSessionId, { event: 'job_snapshot', data: { job: cancelledJob } })
    emitJobEvent(designSessionId, { event: 'job_done', data: { job: cancelledJob } })
  }

  const unlockedPayload = buildUnlockedDraftPayload(payload)

  const draftResult = await persistDraftPayload(username, threadId, draftMessageId, unlockedPayload)

  const thread = await advanceWizardPhase(username, threadId, {
    to: WIZARD_PHASE_DRAFT_REVIEW,
    coreCode: row.coreCode,
    activeDraftId: draftMessageId,
    activePlanId: null,
    handoff: buildRollbackHandoff({
      from: phase,
      to: WIZARD_PHASE_DRAFT_REVIEW,
      reason: 'User unlocked draft from Web UI; execution plan cleared',
      draftMessageId,
      draftRevision: unlockedPayload.revision ?? null
    })
  })

  return { draft: draftResult.message, thread }
}

export async function unlockRequirementsContractForEdit(
  username: string,
  threadId: string,
  draftMessageId: string
): Promise<{
  messageId: string
  payload: Record<string, unknown>
  message: ConversationMessageDto
}> {
  await assertThreadWizardPhase(username, threadId, WIZARD_PHASE_DRAFT_REVIEW)
  await assertActiveDraft(username, threadId, draftMessageId)

  const payload = await loadDraftPayload(username, threadId, draftMessageId)
  const row = await getThreadRow(username, threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')

  if (!isDraftEditable(payload)) {
    throw AppError.badRequest('Draft is already confirmed', 'draft.locked', { reason: 'confirmed' })
  }
  if (isDraftWorkspaceLocked(payload, row)) {
    throw AppError.badRequest(
      'Draft is locked; unlock the draft before editing the contract',
      'draft.locked'
    )
  }
  if (payload.requirementsContract.status !== 'confirmed') {
    throw AppError.badRequest(
      'Requirements contract is not confirmed',
      'draft.requirements_contract_not_confirmed'
    )
  }
  if (payload.linkedPlanId?.trim()) {
    throw AppError.badRequest('Execution tree generation has already started', 'draft.locked', {
      reason: 'plan_started'
    })
  }

  const unlockedPayload = buildUnlockedRequirementsContractPayload(payload)
  return persistDraftPayload(username, threadId, draftMessageId, unlockedPayload)
}

export async function confirmExecutionPlan(
  username: string,
  threadId: string,
  planOrSessionId: string
): Promise<ThreadJobDto> {
  if (isDesignSessionId(planOrSessionId)) {
    return launchJobFromDesignSession(username, threadId, planOrSessionId)
  }

  throw AppError.badRequest(
    'Launch tasks through a DesignSession (ds-*); legacy job confirmation is not supported',
    'job.invalid_status'
  )
}

export async function updateDraftContent(
  username: string,
  threadId: string,
  messageId: string,
  patch: Partial<{
    title: string
    summary: string
    userFlow: string
    techStack: string
    requirementsContractMarkdown: string
    nfr: string[]
    acceptance: TaskLaunchDraftPayload['acceptance']
    outOfScope: string[]
    assumptions: string[]
    revision?: number
  }>
): Promise<{
  messageId: string
  payload: Record<string, unknown>
  message: ConversationMessageDto
  skippedLockedSections: string[]
  requirementsContractSynced: boolean
}> {
  await assertThreadWizardPhase(username, threadId, WIZARD_PHASE_DRAFT_REVIEW)
  const payload = await loadDraftPayload(username, threadId, messageId)
  await assertActiveDraft(username, threadId, messageId, patch.revision)

  const row = await getThreadRow(username, threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')
  if (isDraftWorkspaceLocked(payload, row)) {
    throw AppError.badRequest(
      'Draft is locked; unlock it in the Web UI before editing',
      'draft.locked'
    )
  }

  if (!isDraftEditable(payload)) {
    throw AppError.badRequest('Draft is already confirmed', 'draft.locked', { reason: 'confirmed' })
  }

  const skippedLockedSections: string[] = []
  const next = { ...payload }
  if (patch.title !== undefined) {
    if (isDraftSectionLocked(payload, 'acceptance')) {
      skippedLockedSections.push('title')
    } else {
      next.title = patch.title.trim()
    }
  }
  if (patch.summary !== undefined) next.summary = patch.summary.trim()
  if (patch.userFlow !== undefined) {
    if (isDraftSectionLocked(payload, 'userFlow')) {
      skippedLockedSections.push('userFlow')
    } else {
      next.userFlow = patch.userFlow.trim()
    }
  }
  if (patch.techStack !== undefined) {
    if (isDraftSectionLocked(payload, 'techStack')) {
      skippedLockedSections.push('techStack')
    } else {
      next.techStack = patch.techStack.trim()
    }
  }
  if (patch.requirementsContractMarkdown !== undefined) {
    if (isDraftSectionLocked(payload, 'requirementsContract')) {
      skippedLockedSections.push('requirementsContractMarkdown')
    } else {
      next.requirementsContract = {
        ...payload.requirementsContract,
        markdown: patch.requirementsContractMarkdown.trim()
      }
    }
  }
  if (patch.nfr !== undefined) next.nfr = patch.nfr
  if (patch.acceptance !== undefined) {
    if (isDraftSectionLocked(payload, 'acceptance')) {
      skippedLockedSections.push('acceptance')
    } else {
      next.acceptance = patch.acceptance
    }
  }
  if (patch.outOfScope !== undefined) next.outOfScope = patch.outOfScope
  if (patch.assumptions !== undefined) next.assumptions = patch.assumptions

  const structuralContractChange =
    patch.requirementsContractMarkdown === undefined &&
    !isDraftSectionLocked(payload, 'requirementsContract') &&
    (patch.title !== undefined ||
      patch.summary !== undefined ||
      patch.userFlow !== undefined ||
      patch.techStack !== undefined)

  const synced = structuralContractChange
    ? syncRequirementsContractFromDraft(next, { force: true })
    : next

  const persisted = await persistDraftPayload(username, threadId, messageId, synced, {
    expectedRevision: patch.revision
  })
  return {
    ...persisted,
    skippedLockedSections,
    requirementsContractSynced: structuralContractChange
  }
}

export async function confirmDraftSection(
  username: string,
  threadId: string,
  messageId: string,
  section: keyof TaskLaunchDraftPayload['lockedSections']
): Promise<{
  messageId: string
  payload: Record<string, unknown>
  message: ConversationMessageDto
}> {
  await assertThreadWizardPhase(username, threadId, WIZARD_PHASE_DRAFT_REVIEW)
  await assertActiveDraft(username, threadId, messageId)
  const payload = await loadDraftPayload(username, threadId, messageId)
  if (!isDraftEditable(payload)) {
    throw AppError.badRequest('Draft is already confirmed', 'draft.locked', { reason: 'confirmed' })
  }

  const lockedSections = { ...payload.lockedSections, [section]: true }
  const next: TaskLaunchDraftPayload = { ...payload, lockedSections }

  if (section === 'requirementsContract') {
    next.requirementsContract = {
      ...payload.requirementsContract,
      status: 'confirmed',
      confirmedAt: new Date().toISOString()
    }
  }

  return persistDraftPayload(username, threadId, messageId, next)
}

export async function updateJobPlan(
  username: string,
  threadId: string,
  planOrSessionId: string,
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
): Promise<ThreadJobDto> {
  await assertThreadWizardPhase(username, threadId, WIZARD_PHASE_PLAN_EDIT)
  await assertActivePlan(username, threadId, planOrSessionId)

  const useDesignSession = isDesignSessionId(planOrSessionId)
  const job = useDesignSession
    ? await getDesignSessionAsJob(username, threadId, planOrSessionId)
    : await getThreadJob(username, threadId, planOrSessionId)
  if (!job) throw AppError.notFound('Plan not found', 'job.not_found')
  if (job.status !== 'plan_editing') {
    throw AppError.badRequest(
      'Only plans in editing status can be modified',
      'job.invalid_status',
      { status: job.status }
    )
  }

  const db = getDb()
  const plan = useDesignSession
    ? await loadDesignPlan(db, planOrSessionId)
    : await (await import('../db/job-plan')).loadJobPlan(db, planOrSessionId)
  if (!plan) throw AppError.badRequest('Execution plan not generated', 'draft.plan_not_ready')

  const node = resolvePlanNode(plan, patch.nodeRef)
  if (!node) throw AppError.notFound('Plan node not found', 'draft.node_not_found')

  if (
    node.kind === 'task' &&
    (patch.referenceIds !== undefined || patch.referenceReason !== undefined)
  ) {
    const manifest = useDesignSession
      ? await (
          await import('../design-session/service')
        ).loadDesignReferenceManifest(planOrSessionId)
      : await loadJobReferenceManifest(planOrSessionId)
    if (manifest && patch.referenceIds !== undefined) {
      const idErrors = validateTaskReferenceIds(manifest, patch.referenceIds)
      if (idErrors.length > 0) {
        throw AppError.badRequest('Invalid reference IDs', 'draft.reference_invalid', {
          ids: idErrors.join(', ')
        })
      }
    }
  }

  const milestones = [...plan.milestones]
  if (node.kind === 'milestone') {
    const mi = node.indices[0]
    const m = milestones[mi]
    if (!m) throw AppError.notFound('Milestone not found', 'draft.node_not_found')
    if (m.confirmed) {
      throw AppError.badRequest('Milestone is already confirmed', 'draft.locked', {
        nodeRef: patch.nodeRef,
        reason: 'confirmed'
      })
    }
    milestones[mi] = {
      ...m,
      title: patch.title ?? m.title,
      description: patch.description ?? m.description,
      successCriteria: patch.successCriteria ?? m.successCriteria
    }
  } else if (node.kind === 'slice') {
    const [mi, si] = node.indices
    const m = milestones[mi]
    const slices = [...m.slices]
    const s = slices[si]
    if (!s) throw AppError.notFound('Slice not found', 'draft.node_not_found')
    if (s.confirmed) {
      throw AppError.badRequest('Slice is already confirmed', 'draft.locked', {
        nodeRef: patch.nodeRef,
        reason: 'confirmed'
      })
    }
    slices[si] = {
      ...s,
      title: patch.title ?? s.title,
      description: patch.description ?? s.description,
      successCriteria: patch.successCriteria ?? s.successCriteria
    }
    milestones[mi] = { ...m, slices }
  } else {
    const [mi, si, ti] = node.indices
    const m = milestones[mi]
    const slices = [...m.slices]
    const s = slices[si]
    const tasks = [...s.tasks]
    const t = tasks[ti]
    if (!t) throw AppError.notFound('Task not found', 'draft.node_not_found')
    if (t.confirmed) {
      throw AppError.badRequest('Task is already confirmed', 'draft.locked', {
        nodeRef: patch.nodeRef,
        reason: 'confirmed'
      })
    }
    tasks[ti] = {
      ...t,
      title: patch.title ?? t.title,
      description: patch.description ?? t.description,
      successCriteria: patch.successCriteria ?? t.successCriteria,
      abilityCode: patch.abilityCode ?? t.abilityCode
    }
    slices[si] = { ...s, tasks }
    milestones[mi] = { ...m, slices }
    const flatIdx = plan.tasks.findIndex((ft) => ft.id === patch.nodeRef)
    if (flatIdx >= 0) {
      const flat = plan.tasks[flatIdx]
      plan.tasks[flatIdx] = {
        ...flat,
        title: patch.title ?? flat.title,
        description: patch.description ?? flat.description,
        successCriteria: patch.successCriteria ?? flat.successCriteria,
        contextMarkdown:
          patch.contextMarkdown !== undefined ? patch.contextMarkdown : flat.contextMarkdown,
        abilityCode: patch.abilityCode ?? flat.abilityCode,
        coreCode: patch.coreCode !== undefined ? patch.coreCode.trim() || undefined : flat.coreCode,
        referenceIds:
          patch.referenceIds !== undefined
            ? patch.referenceIds.length > 0
              ? patch.referenceIds
              : undefined
            : flat.referenceIds,
        referenceReason:
          patch.referenceReason !== undefined
            ? patch.referenceReason.trim() || undefined
            : flat.referenceReason
      }
    }
  }

  const nextPlan: SavedJobPlan = { ...plan, milestones }
  if (useDesignSession) {
    const session = await getDesignSessionRow(planOrSessionId)
    if (!session) throw AppError.notFound('Design session not found', 'job.not_found')
    if (patch.expectedPlanRevision === undefined) {
      throw AppError.badRequest(
        'expectedPlanRevision is required for design session plan edits',
        'draft.invalid_payload'
      )
    }
    if (session.planRevision !== patch.expectedPlanRevision) {
      throw AppError.conflict('Execution plan revision has changed', {
        turnErrorCode: 'draft.conflict',
        expectedPlanRevision: patch.expectedPlanRevision,
        currentPlanRevision: session.planRevision
      })
    }
    const nextRevision = session.planRevision + 1
    const updated = await updateDesignSessionRow(planOrSessionId, {
      plan: nextPlan,
      planRevision: nextRevision
    })
    if (!updated) throw AppError.internal('Failed to update execution plan', 'turn.unknown')
    const full = await getDesignSessionAsJob(username, threadId, planOrSessionId)
    if (full) emitJobEvent(planOrSessionId, { event: 'job_snapshot', data: { job: full } })
    return full ?? updated
  }

  const updated = await updateJobRow(planOrSessionId, { plan: nextPlan })
  if (!updated) throw AppError.internal('Failed to update execution plan', 'turn.unknown')

  const full = await getThreadJob(username, threadId, planOrSessionId)
  if (full) emitJobEvent(planOrSessionId, { event: 'job_snapshot', data: { job: full } })
  return full ?? updated
}

export async function confirmPlanNode(
  username: string,
  threadId: string,
  planOrSessionId: string,
  nodeRef: string
): Promise<ThreadJobDto> {
  await assertThreadWizardPhase(username, threadId, WIZARD_PHASE_PLAN_EDIT)
  await assertActivePlan(username, threadId, planOrSessionId)

  const useDesignSession = isDesignSessionId(planOrSessionId)
  const job = useDesignSession
    ? await getDesignSessionAsJob(username, threadId, planOrSessionId)
    : await getThreadJob(username, threadId, planOrSessionId)
  if (!job) throw AppError.notFound('Plan not found', 'job.not_found')
  if (job.status !== 'plan_editing') {
    throw AppError.badRequest(
      'Only plans in editing status can confirm nodes',
      'job.invalid_status',
      { status: job.status }
    )
  }

  const db = getDb()
  const plan = useDesignSession
    ? await loadDesignPlan(db, planOrSessionId)
    : await (await import('../db/job-plan')).loadJobPlan(db, planOrSessionId)
  if (!plan) throw AppError.badRequest('Execution plan not generated', 'draft.plan_not_ready')

  const node = resolvePlanNode(plan, nodeRef)
  if (!node) throw AppError.notFound('Plan node not found', 'draft.node_not_found')

  const milestones = [...plan.milestones]
  if (node.kind === 'milestone') {
    const mi = node.indices[0]
    milestones[mi] = { ...milestones[mi], confirmed: true }
  } else if (node.kind === 'slice') {
    const [mi, si] = node.indices
    const slices = [...milestones[mi].slices]
    slices[si] = { ...slices[si], confirmed: true }
    milestones[mi] = { ...milestones[mi], slices }
  } else {
    const [mi, si, ti] = node.indices
    const slices = [...milestones[mi].slices]
    const tasks = [...slices[si].tasks]
    tasks[ti] = { ...tasks[ti], confirmed: true }
    slices[si] = { ...slices[si], tasks }
    milestones[mi] = { ...milestones[mi], slices }
    const flatIdx = plan.tasks.findIndex((ft) => ft.id === nodeRef)
    if (flatIdx >= 0) {
      plan.tasks[flatIdx] = { ...plan.tasks[flatIdx], confirmed: true }
    }
  }

  const nextPlan: SavedJobPlan = { ...plan, milestones }
  const updated = useDesignSession
    ? await updateDesignSessionRow(planOrSessionId, { plan: nextPlan })
    : await updateJobRow(planOrSessionId, { plan: nextPlan })
  if (!updated) throw AppError.internal('Failed to confirm node', 'turn.unknown')

  const full = useDesignSession
    ? await getDesignSessionAsJob(username, threadId, planOrSessionId)
    : await getThreadJob(username, threadId, planOrSessionId)
  if (full) emitJobEvent(planOrSessionId, { event: 'job_snapshot', data: { job: full } })

  if (useDesignSession && isPlanFullyConfirmed(nextPlan)) {
    const row = await getThreadRow(username, threadId)
    if (row) {
      await getDb()
        .update(designSessions)
        .set({ phase: 'ready_to_launch', updatedAt: nowSec() })
        .where(eq(designSessions.id, planOrSessionId))
      await advanceWizardPhase(username, threadId, {
        to: WIZARD_PHASE_READY_TO_LAUNCH,
        coreCode: row.coreCode,
        activeDraftId: row.activeDraftId,
        activePlanId: planOrSessionId,
        handoff: buildPlanPhaseHandoff({
          from: WIZARD_PHASE_PLAN_EDIT,
          to: WIZARD_PHASE_READY_TO_LAUNCH,
          planId: planOrSessionId,
          draftMessageId: row.activeDraftId,
          reason: 'All plan nodes confirmed'
        })
      })
    }
  }

  return full ?? updated
}

export function isDraftLockedStatus(status: unknown): boolean {
  return normalizeDraftStatus(status) !== 'editing'
}
