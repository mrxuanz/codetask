import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { saveDesignPlan, saveDesignPlanProgress, saveDesignAbilities } from '../db/design-plan'
import { designSessions } from '../db/schema'
import { ensureCoreAvailable, type SupportedCoreCode } from '../conversation/cores'
import { ensureRuntimeRoot, streamAgentTurn } from '../agent-runtime/runner'
import { resolveCoreModel } from '../conversation/models'
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
import type { TaskLaunchDraftPayload } from '../conversation/draft/types'
import { ensureDraftPlanningAbilities } from '../conversation/draft/normalize'
import type { PlanProgressDto } from '../jobs/types'
import { emitJobEvent } from '../jobs/service'
import { AppError } from '../error'
import { createTurnError } from '../../shared/turn-errors.ts'
import {
  createPlannerRun,
  finishPlannerRun,
  loadDesignReferenceManifest,
  mapDesignSessionToJobDto,
  updateDesignSessionRow
} from './service'
import { advanceWizardPhase, buildDraftToPlanHandoff } from '../wizard/phase'
import { WIZARD_PHASE_PLAN_EDIT } from '../wizard/types'

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

async function commitDesignPlanReady(
  designSessionId: string,
  savedPlan: SavedJobPlan,
  counts: { milestones: number; slices: number; tasks: number },
  advancePhase?: { username: string; threadId: string; coreCode: string; draftMessageId: string },
  options?: { planRevision?: number; clearConfirmed?: boolean }
): Promise<boolean> {
  const { clearPlanConfirmedFlags } = await import('@shared/plan-mutations')
  const planToSave = options?.clearConfirmed ? clearPlanConfirmedFlags(savedPlan) : savedPlan
  const planRevision = options?.planRevision ?? 1

  const { getAppContext } = await import('../bootstrap')
  const { putDesignPlanArtifact } = await import('../retention/design-plan-artifacts')
  const { designSessions } = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const artifact = await putDesignPlanArtifact({
    dataDir: getAppContext().dataDir,
    designSessionId,
    planRevision,
    plan: planToSave
  })
  const db = getDb()
  await db
    .update(designSessions)
    .set({
      planArtifactId: artifact.artifactId,
      planArtifactPath: artifact.contentPath,
      planSummaryJson: artifact.summaryJson,
      planCountsJson: JSON.stringify(counts),
      updatedAt: nowSec()
    })
    .where(eq(designSessions.id, designSessionId))

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

  const updated = await updateDesignSessionRow(designSessionId, {
    status: 'plan_editing',
    phase: 'plan_edit',
    planRevision: planRevision ?? 1,
    plan: planToSave,
    planProgress: planReady,
    taskProgress: initialTaskProgress,
    lastError: null
  })
  if (!updated) return false

  emitJobEvent(designSessionId, { event: 'plan_progress', data: { planProgress: planReady } })
  emitJobEvent(designSessionId, {
    event: 'task_progress',
    data: { taskProgress: initialTaskProgress }
  })
  emitJobEvent(designSessionId, { event: 'job_snapshot', data: { job: updated } })
  emitJobEvent(designSessionId, { event: 'job_done', data: { job: updated } })

  if (advancePhase) {
    const { advanceWizardPhase, buildDraftToPlanHandoff } = await import('../wizard/phase')
    const { WIZARD_PHASE_PLAN_EDIT } = await import('../wizard/types')
    const { getMessage } = await import('../conversation/messages')
    const message = await getMessage(
      advancePhase.username,
      advancePhase.threadId,
      advancePhase.draftMessageId,
      { signAssets: false }
    )
    const payload = message?.payload as TaskLaunchDraftPayload | undefined
    if (payload) {
      await advanceWizardPhase(advancePhase.username, advancePhase.threadId, {
        to: WIZARD_PHASE_PLAN_EDIT,
        coreCode: advancePhase.coreCode,
        activeDraftId: advancePhase.draftMessageId,
        activePlanId: designSessionId,
        handoff: buildDraftToPlanHandoff({
          draftMessageId: advancePhase.draftMessageId,
          draftRevision: payload.revision ?? 1,
          planId: designSessionId,
          payload
        })
      })
    }
  }

  return true
}

function summarizePlannerSession(session: PlannerMcpSession): Record<string, unknown> {
  return {
    contextsRegistered: session.taskContexts.size,
    contextKeys: [...session.taskContexts.keys()],
    hasRegisteredPlan: Boolean(session.registeredPlan),
    allowedAbilityCodes: session.allowedAbilityCodes
  }
}

function summarizeDraftForPlanner(draft: TaskLaunchDraftPayload): Record<string, unknown> {
  return {
    draftId: draft.draftId,
    status: draft.status,
    contractStatus: draft.requirementsContract?.status ?? 'unknown',
    abilitiesCount: draft.abilities.length,
    abilities: draft.abilities.map((ability) => ({
      code: ability.abilityCode,
      core: ability.recommendedCoreCode ?? null
    })),
    referenceCount: draft.references.length
  }
}

async function pushDesignPlanningProgress(
  designSessionId: string,
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
  await saveDesignPlan(db, designSessionId, partialPlan)
  await saveDesignPlanProgress(db, designSessionId, planProgress)
  await db
    .update(designSessions)
    .set({ updatedAt: nowSec() })
    .where(eq(designSessions.id, designSessionId))

  const rows = await db
    .select()
    .from(designSessions)
    .where(eq(designSessions.id, designSessionId))
    .limit(1)
  const job = rows[0] ? await mapDesignSessionToJobDto(rows[0], { includePlan: true }) : null
  if (!job) return

  emitJobEvent(designSessionId, {
    event: 'plan_progress',
    data: { planProgress, plan: partialPlan }
  })
  emitJobEvent(designSessionId, { event: 'job_snapshot', data: { job } })

  plannerSandboxDebug('runDesignPlanner: partial progress', {
    designSessionId,
    contextsRegistered: done,
    contextsTotal: total,
    partialTasks: partialPlan.tasks.length
  })
}

async function runDesignPlanner(
  username: string,
  threadId: string,
  designSessionId: string,
  draft: TaskLaunchDraftPayload,
  workspacePath: string,
  coreCode: string,
  options?: {
    regenerationInstruction?: string
    planRevisionBefore?: number
  }
): Promise<void> {
  const { findWorkloadOccupant } = await import('../jobs/workload-slot')
  if (await findWorkloadOccupant(username, designSessionId)) {
    plannerSandboxDebug('runDesignPlanner: skipped (workload slot busy)', { designSessionId })
    return
  }
  if (!getAppContext().runtimeRegistry.tryStartJobPlanning(designSessionId, username)) {
    plannerSandboxDebug('runDesignPlanner: skipped (planning slot busy)', { designSessionId })
    return
  }

  const revisionBefore = options?.planRevisionBefore ?? 0
  const runId = await createPlannerRun({ designSessionId, planRevisionBefore: revisionBefore })
  const planningDraft = ensureDraftPlanningAbilities(draft, coreCode as SupportedCoreCode)
  if (planningDraft.abilities.length > 0 && draft.abilities.length === 0) {
    await saveDesignAbilities(
      getDb(),
      designSessionId,
      planningDraft.abilities.map((ability) => ({
        abilityCode: ability.abilityCode,
        label: ability.label,
        recommendedCoreCode: ability.recommendedCoreCode
      }))
    )
    plannerSandboxDebug('runDesignPlanner: inferred draft abilities', {
      designSessionId,
      abilityCodes: planningDraft.abilities.map((ability) => ability.abilityCode)
    })
  }
  plannerSandboxDebug('runDesignPlanner: start', {
    designSessionId,
    threadId,
    workspacePath,
    coreCode,
    draft: summarizeDraftForPlanner(planningDraft),
    regeneration: Boolean(options?.regenerationInstruction?.trim())
  })

  const { getDesignSessionRow } = await import('./service')
  const sessionRow = await getDesignSessionRow(designSessionId)
  const phaseAdvance = sessionRow
    ? {
        username,
        threadId,
        coreCode,
        draftMessageId: sessionRow.draftMessageId
      }
    : undefined

  let planCommitted = false
  let plannerSession: PlannerMcpSession | null = null

  try {
    const plannerCoreCode = await resolvePlannerCoreCode(coreCode)
    const core = await ensureCoreAvailable(plannerCoreCode)
    const runtimeRoot = ensureRuntimeRoot(
      getAppContext().dataDir,
      threadId,
      core.code as SupportedCoreCode
    )
    const model = resolveCoreModel(core.code as SupportedCoreCode)

    const mcpSessionId = `plan-mcp-${randomUUID()}`
    const turnAbort = new AbortController()
    const referenceManifest = await loadDesignReferenceManifest(designSessionId)

    plannerSession = {
      sessionId: mcpSessionId,
      jobId: designSessionId,
      threadId,
      allowedAbilityCodes: planningDraft.abilities.map((ability) => ability.abilityCode),
      validReferenceIds:
        referenceManifest?.references.map((item) => item.id) ??
        planningDraft.references.map((item) => item.id),
      referenceManifest,
      taskContexts: new Map(),
      registeredPlan: null,
      onTaskContextRegistered: (_key, done) => {
        const partial = plannerSession!.registeredPlan
          ? flattenRegisteredPlan(plannerSession!.registeredPlan, plannerSession!.taskContexts)
          : buildPartialPlanFromContexts(plannerSession!.taskContexts)
        void pushDesignPlanningProgress(
          designSessionId,
          done,
          partial,
          plannerSession!.registeredPlan
        )
      },
      onPlanRegistered: (counts) => {
        if (!plannerSession!.registeredPlan) return
        const saved = flattenRegisteredPlan(
          plannerSession!.registeredPlan,
          plannerSession!.taskContexts
        )
        const nextRevision = revisionBefore + 1
        void commitDesignPlanReady(designSessionId, saved, counts, phaseAdvance, {
          planRevision: nextRevision,
          clearConfirmed: Boolean(options?.regenerationInstruction)
        }).then((ok) => {
          if (!ok) return
          planCommitted = true
          void finishPlannerRun(runId, { status: 'completed', planRevisionAfter: nextRevision })
          turnAbort.abort()
        })
      }
    }

    registerPlannerMcpSession(plannerSession)

    plannerSandboxDebug('runDesignPlanner: mcp session registered', {
      designSessionId,
      mcpSessionId,
      ...summarizePlannerSession(plannerSession),
      validReferenceIds: plannerSession.validReferenceIds.length,
      hasReferenceManifest: Boolean(referenceManifest)
    })

    let mcpUrl: string | undefined
    try {
      mcpUrl = buildPlannerMcpUrl({ sessionId: mcpSessionId, jobId: designSessionId })
    } catch {
      mcpUrl = undefined
    }

    try {
      const plannerPrompt = buildPlannerUserMessage({
        draft: planningDraft,
        workspacePath,
        threadId
      })
      const regenerationSection = options?.regenerationInstruction?.trim()
        ? [
            '',
            '## Plan regeneration instruction',
            '',
            options.regenerationInstruction.trim(),
            '',
            'Produce a revised execution plan that addresses the instruction above.',
            'All prior plan confirmations are void — treat this as a fresh structured plan.'
          ].join('\n')
        : ''

      const plannerReadRoots = referenceManifest
        ? resolveReferenceManifestReadRoots({
            workspaceRoot: workspacePath,
            manifest: referenceManifest
          })
        : resolveDraftReferenceReadRoots({ threadId, draft: planningDraft })

      plannerSandboxDebug('runDesignPlanner: entering streamAgentTurn', {
        designSessionId,
        provider: core.code,
        model,
        promptChars: (plannerPrompt + regenerationSection).length,
        readRoots: plannerReadRoots.length,
        mcpUrl: Boolean(mcpUrl)
      })

      let chunkCount = 0
      for await (const chunk of streamAgentTurn({
        role: 'planner',
        provider: core.code as SupportedCoreCode,
        workspaceRoot: workspacePath,
        runtimeRoot,
        prompt: plannerPrompt + regenerationSection,
        model,
        systemPrompt: resolvePlannerPromptBody(),
        mcpUrl,
        readRoots: plannerReadRoots.length > 0 ? plannerReadRoots : undefined,
        signal: turnAbort.signal
      })) {
        chunkCount += 1
        if (chunk.type !== 'thinking_delta' && chunk.type !== 'delta') {
          plannerSandboxDebug('runDesignPlanner: turn chunk', {
            designSessionId,
            chunkType: chunk.type,
            chunkCount
          })
        }
        if (chunk.type === 'completed') break
      }

      plannerSandboxDebug('runDesignPlanner: streamAgentTurn finished', {
        designSessionId,
        chunkCount,
        ...summarizePlannerSession(plannerSession),
        planCommitted
      })
    } finally {
      unregisterPlannerMcpSession(mcpSessionId)
      plannerSandboxDebug('runDesignPlanner: mcp session unregistered', {
        designSessionId,
        mcpSessionId
      })
    }

    if (planCommitted) {
      plannerSandboxDebug('runDesignPlanner: done (plan committed during stream)', {
        designSessionId
      })
      return
    }

    const session = plannerSession
    if (!session?.registeredPlan) {
      plannerSandboxDebug('runDesignPlanner: failed (no register_plan)', {
        designSessionId,
        ...summarizePlannerSession(session)
      })
      throw createTurnError('draft.plan_not_ready', {
        detail: 'Planner did not register a structured plan via register_plan'
      })
    }

    const savedPlan = flattenRegisteredPlan(session.registeredPlan, session.taskContexts)
    const counts = countPlanUnits(session.registeredPlan)
    const nextRevision = revisionBefore + 1
    const ok = await commitDesignPlanReady(designSessionId, savedPlan, counts, phaseAdvance, {
      planRevision: nextRevision,
      clearConfirmed: Boolean(options?.regenerationInstruction)
    })
    if (ok) {
      plannerSandboxDebug('runDesignPlanner: done (plan committed after stream)', {
        designSessionId,
        milestones: counts.milestones,
        slices: counts.slices,
        tasks: counts.tasks
      })
      await finishPlannerRun(runId, { status: 'completed', planRevisionAfter: nextRevision })
    }
  } catch (error) {
    if (planCommitted) return

    const turnError =
      error instanceof Error && 'code' in error
        ? (error as { code?: string; message?: string; detail?: string | null })
        : null
    plannerSandboxDebug('runDesignPlanner: failed', {
      designSessionId,
      errorCode: turnError?.code ?? null,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorDetail: turnError?.detail ?? null,
      ...(plannerSession ? summarizePlannerSession(plannerSession) : {})
    })

    const { getUserDesignSessionAsJob } = await import('./service')
    const current = await getUserDesignSessionAsJob(username, designSessionId)
    if (current?.status === 'cancelled') {
      await finishPlannerRun(runId, { status: 'cancelled' })
      return
    }

    const failure = planFailureFromSandboxError(error)
    const job = await updateDesignSessionRow(designSessionId, {
      status: 'failed',
      planProgress: failure.planProgress,
      lastError: failure.lastError
    })
    await finishPlannerRun(runId, {
      status: 'failed',
      error: failure.lastError.message
    })
    if (job) {
      emitJobEvent(designSessionId, {
        event: 'plan_progress',
        data: { planProgress: failure.planProgress }
      })
      emitJobEvent(designSessionId, {
        event: 'error',
        data: { error: failure.lastError }
      })
      emitJobEvent(designSessionId, { event: 'job_done', data: { job } })
    }
  } finally {
    getAppContext().runtimeRegistry.endJobPlanning(designSessionId)
    const { advanceJobQueue } = await import('../jobs/job-queue')
    await advanceJobQueue(username)
  }
}

export function scheduleDesignSessionPlanning(
  username: string,
  threadId: string,
  designSessionId: string,
  draft: TaskLaunchDraftPayload,
  workspacePath: string,
  coreCode: string
): void {
  plannerSandboxDebug('scheduleDesignSessionPlanning', {
    designSessionId,
    threadId,
    coreCode,
    draft: summarizeDraftForPlanner(draft)
  })
  void runDesignPlanner(username, threadId, designSessionId, draft, workspacePath, coreCode)
}

export function scheduleDesignSessionPlanRegeneration(
  username: string,
  threadId: string,
  designSessionId: string,
  draft: TaskLaunchDraftPayload,
  workspacePath: string,
  coreCode: string,
  options: { instruction: string; planRevisionBefore: number }
): void {
  void runDesignPlanner(username, threadId, designSessionId, draft, workspacePath, coreCode, {
    regenerationInstruction: options.instruction,
    planRevisionBefore: options.planRevisionBefore
  })
}

export async function retryDesignSessionPlanning(
  username: string,
  designSessionId: string
): Promise<import('../jobs/types').ThreadJobDto> {
  const { getUserDesignSessionAsJob } = await import('./service')
  const session = await getUserDesignSessionAsJob(username, designSessionId)
  if (!session) throw AppError.notFound('Design session not found', 'design_session.not_found')
  if (!['failed', 'cancelled', 'plan_editing', 'planning'].includes(session.status)) {
    throw AppError.badRequest(
      `Status ${session.status} does not allow replanning`,
      'job.invalid_status',
      { status: session.status }
    )
  }

  const { getMessage } = await import('../conversation/messages')
  const message = await getMessage(username, session.threadId, session.draftMessageId, {
    signAssets: false
  })
  if (!message || message.kind !== 'task-launch-draft') {
    throw AppError.notFound('Original task draft not found', 'draft.not_found')
  }
  const payload = message.payload as TaskLaunchDraftPayload | undefined
  if (!payload?.draftId)
    throw AppError.badRequest('Task draft payload invalid', 'draft.invalid_payload')

  const { getThreadRow } = await import('../threads/service')
  const { getProject } = await import('../projects/service')
  const row = await getThreadRow(username, session.threadId)
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

  const updated = await updateDesignSessionRow(designSessionId, {
    status: 'planning',
    phase: 'plan_generating',
    plan: null,
    planProgress,
    taskProgress,
    lastError: null
  })
  if (!updated) throw AppError.internal('Failed to retry planning', 'turn.unknown')

  emitJobEvent(designSessionId, { event: 'plan_progress', data: { planProgress } })
  emitJobEvent(designSessionId, { event: 'task_progress', data: { taskProgress } })
  emitJobEvent(designSessionId, { event: 'job_snapshot', data: { job: updated } })

  scheduleDesignSessionPlanning(
    username,
    session.threadId,
    designSessionId,
    payload,
    project.workspaceRoot,
    row.coreCode
  )
  return updated
}

export async function advanceDesignSessionToPlanEdit(
  username: string,
  threadId: string,
  input: {
    designSessionId: string
    draftMessageId: string
    draftRevision: number
    payload: TaskLaunchDraftPayload
    coreCode: string
  }
): Promise<void> {
  await advanceWizardPhase(username, threadId, {
    to: WIZARD_PHASE_PLAN_EDIT,
    coreCode: input.coreCode,
    activeDraftId: input.draftMessageId,
    activePlanId: input.designSessionId,
    handoff: buildDraftToPlanHandoff({
      draftMessageId: input.draftMessageId,
      draftRevision: input.draftRevision,
      planId: input.designSessionId,
      payload: input.payload
    })
  })
}
