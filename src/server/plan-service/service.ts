import { randomUUID } from 'crypto'
import { and, eq } from 'drizzle-orm'
import { AppError } from '../error'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { loadDesignAbilities, loadDesignPlan } from '../db/design-plan'
import { designRuns, designSessions } from '../db/schema'
import {
  getDesignSessionAsJob,
  getDesignSessionRow,
  loadDesignReferenceManifest,
  updateDesignSessionRow
} from '../design-session/service'
import { scheduleDesignSessionPlanRegeneration } from '../design-session/planner'
import type { PlannerRegisteredPlan } from '../planner/plan-types'
import type { SavedJobPlan } from '../planner/plan-types'
import {
  countPlanUnits,
  normalizeRegisteredPlan,
  validatePlanReferenceIds,
  validatePlanShape,
  validateRegisteredPlanDependencyGraph
} from '../planner/mcp/normalize'
import { validatePlanAbilityCodes } from '../planner/plan-ability-validation'
import { flattenRegisteredPlan } from '../planner/save-plan'
import { putDesignPlanArtifact } from '../retention/design-plan-artifacts'
import { emitJobEvent } from '../jobs/service'
import type { ThreadJobDto } from '../jobs/types'
import {
  assertThreadWizardPhase,
  assertActivePlan,
  advanceWizardPhase,
  buildPlanPhaseHandoff
} from '../wizard/phase'
import {
  WIZARD_PHASE_PLAN_EDIT,
  WIZARD_PHASE_PLAN_GENERATING,
  WIZARD_PHASE_READY_TO_LAUNCH
} from '../wizard/types'
import { isDesignSessionId } from '@shared/design-session'
import { clearPlanConfirmedFlags, buildPlanSummary } from '@shared/plan-mutations'

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function extractContextMarkdownByNodeRef(milestonesRaw: unknown): Map<string, string> {
  const map = new Map<string, string>()
  if (!Array.isArray(milestonesRaw)) return map
  milestonesRaw.forEach((milestone, mIdx) => {
    if (!milestone || typeof milestone !== 'object') return
    const slices = (milestone as Record<string, unknown>).slices
    if (!Array.isArray(slices)) return
    slices.forEach((slice, sIdx) => {
      if (!slice || typeof slice !== 'object') return
      const tasks = (slice as Record<string, unknown>).tasks
      if (!Array.isArray(tasks)) return
      tasks.forEach((task, tIdx) => {
        if (!task || typeof task !== 'object') return
        const contextMarkdown = (task as Record<string, unknown>).contextMarkdown
        if (typeof contextMarkdown === 'string' && contextMarkdown.trim()) {
          map.set(`m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1}`, contextMarkdown.trim())
        }
      })
    })
  })
  return map
}

function registeredPlanToSavedPlan(
  registered: PlannerRegisteredPlan,
  existingPlan: SavedJobPlan | null,
  explicitContexts: Map<string, string>
): SavedJobPlan {
  const contexts = new Map<string, import('../planner/plan-types').PlannerRegisteredTaskContext>()

  registered.milestones.forEach((milestone, mIdx) => {
    milestone.slices.forEach((slice, sIdx) => {
      slice.tasks.forEach((task, tIdx) => {
        const key = `m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1}`
        const explicit = explicitContexts.get(key)
        const prior = existingPlan?.tasks.find((row) => row.id === key)
        const content = explicit ?? prior?.contextMarkdown ?? ''
        const taskTitle = task.title ?? prior?.title ?? key
        if (content.trim()) {
          contexts.set(key, { taskTitle, content: content.trim() })
        }
      })
    })
  })

  return flattenRegisteredPlan(registered, contexts)
}

async function assertPlanRevisionLock(
  designSessionId: string,
  expectedPlanRevision: number
): Promise<NonNullable<Awaited<ReturnType<typeof getDesignSessionRow>>>> {
  const session = await getDesignSessionRow(designSessionId)
  if (!session) throw AppError.notFound('Design session not found', 'design_session.not_found')
  if (session.planRevision !== expectedPlanRevision) {
    throw AppError.conflict(
      'Execution plan revision has changed; please reload and retry',
      {
        expectedPlanRevision,
        currentPlanRevision: session.planRevision
      },
      'draft.conflict',
      { expectedPlanRevision, currentPlanRevision: session.planRevision }
    )
  }
  return session
}

async function createDesignRun(input: {
  designSessionId: string
  kind: 'planner' | 'wizard_edit'
  planRevisionBefore: number
  toolName?: string
}): Promise<string> {
  const runId = `drun-${randomUUID()}`
  const db = getDb()
  await db.insert(designRuns).values({
    id: runId,
    designSessionId: input.designSessionId,
    kind: input.kind,
    status: 'completed',
    startedAt: nowSec(),
    finishedAt: nowSec(),
    plannerSessionId: null,
    planRevisionBefore: input.planRevisionBefore,
    planRevisionAfter: input.planRevisionBefore + 1,
    toolName: input.toolName ?? null,
    error: null
  })
  return runId
}

async function persistPlanMutation(input: {
  username: string
  threadId: string
  designSessionId: string
  session: NonNullable<Awaited<ReturnType<typeof getDesignSessionRow>>>
  nextPlan: SavedJobPlan
  toolName: string
}): Promise<ThreadJobDto> {
  const cleared = clearPlanConfirmedFlags(input.nextPlan)
  const nextRevision = input.session.planRevision + 1
  const { dataDir } = getAppContext()
  const artifact = await putDesignPlanArtifact({
    dataDir,
    designSessionId: input.designSessionId,
    planRevision: nextRevision,
    plan: cleared
  })

  const counts = buildPlanSummary(cleared)
  const phasePatch =
    input.session.phase === WIZARD_PHASE_READY_TO_LAUNCH
      ? { phase: 'plan_edit' as const, status: 'plan_editing' as const }
      : {}

  const db = getDb()
  await db
    .update(designSessions)
    .set({
      planRevision: nextRevision,
      planArtifactId: artifact.artifactId,
      planArtifactPath: artifact.contentPath,
      planSummaryJson: artifact.summaryJson,
      planCountsJson: JSON.stringify(counts),
      ...phasePatch,
      updatedAt: nowSec()
    })
    .where(eq(designSessions.id, input.designSessionId))

  const updated = await updateDesignSessionRow(input.designSessionId, {
    plan: cleared,
    planRevision: nextRevision,
    ...phasePatch
  })
  if (!updated) throw AppError.internal('Failed to update execution plan', 'turn.unknown')

  await createDesignRun({
    designSessionId: input.designSessionId,
    kind: 'wizard_edit',
    planRevisionBefore: input.session.planRevision,
    toolName: input.toolName
  })

  if (phasePatch.phase) {
    const row = await import('../threads/service').then((m) =>
      m.getThreadRow(input.username, input.threadId)
    )
    if (row?.wizardPhase === WIZARD_PHASE_READY_TO_LAUNCH) {
      await advanceWizardPhase(input.username, input.threadId, {
        to: WIZARD_PHASE_PLAN_EDIT,
        coreCode: row.coreCode,
        activeDraftId: row.activeDraftId,
        activePlanId: input.designSessionId,
        handoff: buildPlanPhaseHandoff({
          from: WIZARD_PHASE_READY_TO_LAUNCH,
          to: WIZARD_PHASE_PLAN_EDIT,
          planId: input.designSessionId,
          draftMessageId: row.activeDraftId,
          reason: 'Execution plan replaced; confirmations reset'
        })
      })
    }
  }

  emitJobEvent(input.designSessionId, {
    event: 'job_snapshot',
    data: { job: updated }
  })

  const full = await getDesignSessionAsJob(input.username, input.threadId, input.designSessionId)
  return full ?? updated
}

export async function replaceExecutionPlan(
  username: string,
  threadId: string,
  input: {
    designSessionId: string
    expectedPlanRevision: number
    milestones: unknown
  }
): Promise<ThreadJobDto> {
  if (!isDesignSessionId(input.designSessionId)) {
    throw AppError.badRequest('designSessionId is required', 'job.invalid_id')
  }

  await assertThreadWizardPhase(username, threadId, WIZARD_PHASE_PLAN_EDIT)
  await assertActivePlan(username, threadId, input.designSessionId)

  const session = await assertPlanRevisionLock(input.designSessionId, input.expectedPlanRevision)
  if (session.status !== 'plan_editing') {
    throw AppError.badRequest(
      'Only plans in editing status can be replaced',
      'job.invalid_status',
      { status: session.status }
    )
  }

  const db = getDb()
  const existingPlan = await loadDesignPlan(db, input.designSessionId)
  if (!existingPlan?.tasks?.length) {
    throw AppError.badRequest('Execution plan not generated', 'draft.plan_not_ready')
  }

  let registered: PlannerRegisteredPlan
  try {
    registered = normalizeRegisteredPlan({ milestones: input.milestones })
    validatePlanShape(registered)
    validateRegisteredPlanDependencyGraph(registered)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Execution plan structure invalid'
    throw AppError.badRequest(message, 'draft.invalid_payload')
  }

  const manifest = await loadDesignReferenceManifest(input.designSessionId)
  const abilities = await loadDesignAbilities(db, input.designSessionId)
  const validReferenceIds = manifest?.references.map((item) => item.id) ?? []
  try {
    validatePlanAbilityCodes(
      registered,
      abilities.map((ability) => ability.abilityCode)
    )
    validatePlanReferenceIds(registered, validReferenceIds, manifest)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reference validation failed'
    throw AppError.badRequest(message, 'draft.reference_invalid')
  }

  const explicitContexts = extractContextMarkdownByNodeRef(input.milestones)
  const nextPlan = registeredPlanToSavedPlan(registered, existingPlan, explicitContexts)
  if (countPlanUnits(registered).tasks < 1) {
    throw AppError.badRequest('Execution plan cannot be empty', 'draft.invalid_payload')
  }

  return persistPlanMutation({
    username,
    threadId,
    designSessionId: input.designSessionId,
    session,
    nextPlan,
    toolName: 'replace_execution_plan'
  })
}

export async function requestPlanRegeneration(
  username: string,
  threadId: string,
  input: {
    designSessionId: string
    expectedPlanRevision: number
    instruction: string
  }
): Promise<ThreadJobDto> {
  if (!isDesignSessionId(input.designSessionId)) {
    throw AppError.badRequest('designSessionId is required', 'job.invalid_id')
  }

  const instruction = input.instruction?.trim()
  if (!instruction) {
    throw AppError.badRequest('instruction is required', 'draft.invalid_payload')
  }

  await assertThreadWizardPhase(username, threadId, [
    WIZARD_PHASE_PLAN_EDIT,
    WIZARD_PHASE_READY_TO_LAUNCH
  ])
  await assertActivePlan(username, threadId, input.designSessionId)

  const session = await assertPlanRevisionLock(input.designSessionId, input.expectedPlanRevision)
  if (!['plan_editing', 'planning'].includes(session.status)) {
    throw AppError.badRequest('Current status does not allow regeneration', 'job.invalid_status', {
      status: session.status
    })
  }

  const db = getDb()
  const rows = await db
    .select()
    .from(designSessions)
    .where(
      and(
        eq(designSessions.id, input.designSessionId),
        eq(designSessions.threadId, threadId),
        eq(designSessions.username, username)
      )
    )
    .limit(1)
  if (!rows[0]) throw AppError.notFound('Design session not found', 'design_session.not_found')

  const { getThreadRow } = await import('../threads/service')
  const { getMessage } = await import('../conversation/messages')
  const { getProject } = await import('../projects/service')
  const row = await getThreadRow(username, threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')
  const project = await getProject(username, row.projectId)
  if (!project) throw AppError.notFound('Project not found', 'project.not_found')

  const message = await getMessage(username, threadId, session.draftMessageId, {
    signAssets: false
  })
  if (!message || message.kind !== 'task-launch-draft') {
    throw AppError.notFound('Task draft message not found', 'draft.not_found')
  }
  const payload = message.payload as import('../conversation/draft/types').TaskLaunchDraftPayload
  if (!payload?.draftId)
    throw AppError.badRequest('Task draft payload invalid', 'draft.invalid_payload')

  const phasePatch =
    session.phase === WIZARD_PHASE_READY_TO_LAUNCH
      ? { phase: 'plan_edit' as const, status: 'plan_editing' as const }
      : { phase: 'plan_generating' as const, status: 'planning' as const }

  const updated = await updateDesignSessionRow(input.designSessionId, {
    ...phasePatch,
    lastError: null
  })
  if (!updated) throw AppError.internal('Failed to start regeneration', 'turn.unknown')

  const regenHandoff = buildPlanPhaseHandoff({
    from:
      row.wizardPhase === WIZARD_PHASE_READY_TO_LAUNCH
        ? WIZARD_PHASE_READY_TO_LAUNCH
        : WIZARD_PHASE_PLAN_EDIT,
    to: WIZARD_PHASE_PLAN_GENERATING,
    planId: input.designSessionId,
    draftMessageId: session.draftMessageId,
    reason: `Plan regeneration: ${instruction.slice(0, 200)}`
  })

  await advanceWizardPhase(username, threadId, {
    to: WIZARD_PHASE_PLAN_GENERATING,
    coreCode: row.coreCode,
    activeDraftId: session.draftMessageId,
    activePlanId: input.designSessionId,
    handoff: regenHandoff
  })

  emitJobEvent(input.designSessionId, { event: 'job_snapshot', data: { job: updated } })

  scheduleDesignSessionPlanRegeneration(
    username,
    threadId,
    input.designSessionId,
    payload,
    project.workspaceRoot,
    row.coreCode,
    {
      instruction,
      planRevisionBefore: session.planRevision
    }
  )

  return updated
}
