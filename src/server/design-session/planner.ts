import { randomUUID } from 'crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { saveDesignAbilities } from '../db/design-plan'
import { threadJobs } from '../db/schema'
import { ensureCoreAvailable, type SupportedCoreCode } from '../conversation/cores'
import { ensureJobRuntimeRoot, streamAgentTurn } from '../agent-runtime/runner'
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
  isPlannerPlanCommitted,
  type PlannerMcpSession
} from '../planner/mcp/session'
import {
  defaultPlanProgress,
  defaultTaskProgress,
  flattenRegisteredPlan
} from '../planner/save-plan'
import type { SavedJobPlan } from '../planner/plan-types'
import { countPlanUnits } from '../planner/mcp/normalize'
import { plannerSandboxDebug } from '../debug/planner-sandbox'
import { planFailureFromSandboxError } from '../sandbox/sandbox-failure'
import type { TaskLaunchDraftPayload } from '../conversation/draft/types'
import { ensureDraftPlanningAbilities } from '../conversation/draft/normalize'
import type { PlanProgressDto } from '../legacy-control-plane/types'
import { emitJobEvent } from '../legacy-control-plane/service'
import { AppError } from '../error'
import { createTurnError } from '../../shared/turn-errors.ts'
import {
  createPlannerRun,
  finishPlannerRun,
  loadDesignReferenceManifest,
  updateDesignSessionRow,
  updateDesignSessionRowFenced
} from './service'
import { advanceWizardPhase, buildDraftToPlanHandoff } from '../wizard/phase'
import { WIZARD_PHASE_PLAN_EDIT } from '../wizard/types'
import type { PlanningRunOutcome } from '../legacy-control-plane/run-lifecycle'
import { getRunController } from '../legacy-control-plane/workload-slot-store'
import { runWithExecutionRunContext } from '../legacy-control-plane/execution-run-context'

export async function commitDesignPlanReady(
  designSessionId: string,
  runId: string,
  savedPlan: SavedJobPlan,
  counts: { milestones: number; slices: number; tasks: number },
  advancePhase?: { username: string; threadId: string; coreCode: string; draftMessageId: string },
  options?: { planRevision?: number; clearConfirmed?: boolean }
): Promise<boolean> {
  const { clearPlanConfirmedFlags } = await import('@shared/plan-mutations')
  const planToSave = options?.clearConfirmed ? clearPlanConfirmedFlags(savedPlan) : savedPlan
  const planRevision = options?.planRevision ?? 1

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

  const { updateDesignSessionRowFenced } = await import('./service')
  const updated = await updateDesignSessionRowFenced(designSessionId, runId, {
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

export async function commitDesignPlanReadyFenced(
  designSessionId: string,
  runId: string,
  savedPlan: SavedJobPlan,
  counts: { milestones: number; slices: number; tasks: number }
): Promise<boolean> {
  return commitDesignPlanReady(designSessionId, runId, savedPlan, counts)
}

function summarizePlannerSession(session: PlannerMcpSession): Record<string, unknown> {
  return {
    contextsRegistered: session.taskContexts.size,
    contextKeys: [...session.taskContexts.keys()],
    hasPlanOutline: Boolean(session.planOutline),
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
  runId: string,
  done: number,
  partialPlan: SavedJobPlan,
  planOutline: import('../planner/plan-types').PlannerRegisteredPlan
): Promise<void> {
  const counts = countPlanUnits(planOutline)
  const total = counts.tasks
  const planProgress: PlanProgressDto = {
    phase: 'planning',
    status: 'running',
    contextsRegistered: done,
    contextsTotal: total,
    milestones: counts.milestones,
    slices: counts.slices,
    tasks: counts.tasks,
    progressCode: done === 0 ? 'plan.outline_ready' : 'plan.planning_partial',
    progressParams: { done, total },
    message: null
  }

  const job = await updateDesignSessionRowFenced(designSessionId, runId, {
    plan: partialPlan,
    planProgress
  })
  if (!job) {
    throw AppError.badRequest('Plan session closed or stale run', 'plan.stale_run')
  }

  emitJobEvent(designSessionId, {
    event: 'plan_progress',
    data: { planProgress, plan: partialPlan }
  })
  emitJobEvent(designSessionId, { event: 'job_snapshot', data: { job } })

  plannerSandboxDebug('runDesignPlanner: partial progress', {
    designSessionId,
    runId,
    contextsRegistered: done,
    contextsTotal: total,
    partialTasks: partialPlan.tasks.length
  })
}

export async function pushDesignPlanningProgressFenced(
  designSessionId: string,
  runId: string,
  done: number,
  partialPlan: SavedJobPlan,
  planOutline: import('../planner/plan-types').PlannerRegisteredPlan
): Promise<void> {
  return pushDesignPlanningProgress(designSessionId, runId, done, partialPlan, planOutline)
}

async function commitPlanningSoftPause(
  designSessionId: string,
  designRunId: string
): Promise<boolean> {
  const registry = getAppContext().runtimeRegistry
  if (!registry.shouldStopPlanning(designSessionId)) return false

  registry.clearPlanningControl(designSessionId)
  const planProgress: PlanProgressDto = {
    ...defaultPlanProgress(),
    phase: 'idle',
    status: 'pending',
    progressCode: 'plan.pending',
    progressParams: null,
    message: null
  }
  const job = await updateDesignSessionRow(designSessionId, {
    planProgress,
    lastError: createTurnError('job.paused').toDto()
  })
  await finishPlannerRun(designRunId, { status: 'cancelled' })
  if (job) {
    emitJobEvent(designSessionId, { event: 'plan_progress', data: { planProgress } })
    emitJobEvent(designSessionId, { event: 'job_snapshot', data: { job } })
  }
  return true
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
  const { claimWorkloadSlotTx } = await import('../legacy-control-plane/workload-slot-store')
  const run = await claimWorkloadSlotTx({
    username,
    ownerKind: 'thread_job',
    ownerId: designSessionId,
    kind: 'planning',
    pool: 'planning'
  })
  if (!run) {
    plannerSandboxDebug('runDesignPlanner: skipped (workload slot unavailable), waiting', {
      designSessionId
    })
    const planProgress: PlanProgressDto = {
      ...defaultPlanProgress(),
      phase: 'idle',
      status: 'pending',
      progressCode: 'plan.pending',
      progressParams: null,
      message: null
    }
    const updated = await updateDesignSessionRow(designSessionId, { planProgress })
    if (updated) {
      emitJobEvent(designSessionId, { event: 'plan_progress', data: { planProgress } })
      emitJobEvent(designSessionId, { event: 'job_snapshot', data: { job: updated } })
    }
    const { advanceWorkloadQueue } = await import('../legacy-control-plane/workload-slot-store')
    await advanceWorkloadQueue(username).catch((error) => {
      console.warn(
        '[runDesignPlanner] advance queue after planning wait failed',
        designSessionId,
        error
      )
    })
    return
  }

  // Planner uses snapshot-read / runtimeRoot writes only — never exclusive main-workspace lease.
  const { releaseWorkspaceLeaseForOwner } =
    await import('../legacy-control-plane/workspace-lease-store')

  getAppContext().runtimeRegistry.tryStartJobPlanning(designSessionId, username)

  const revisionBefore = options?.planRevisionBefore ?? 0
  const designRunId = await createPlannerRun({
    designSessionId,
    planRevisionBefore: revisionBefore
  })
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
    runId: run.runId,
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
  let runOutcome: PlanningRunOutcome = 'success'
  let plannerSession: PlannerMcpSession | null = null
  const plannerScopeId = `${designSessionId}:${run.runId}`

  const { registerRunRuntime } = await import('../legacy-control-plane/runtime-supervisor')
  const { buildCursorPlannerRuntimeHandle } =
    await import('../legacy-control-plane/runtime-handle-cursor')
  const { updateRunRuntimeRef } = await import('../legacy-control-plane/workload-slot-store')
  registerRunRuntime(run.runId, buildCursorPlannerRuntimeHandle(plannerScopeId))
  await updateRunRuntimeRef(run.runId, { kind: 'cursor-acp', scopeId: plannerScopeId })

  try {
    const plannerCoreCode = await resolvePlannerCoreCode(coreCode)
    const core = await ensureCoreAvailable(plannerCoreCode)
    const runtimeRoot = ensureJobRuntimeRoot(
      getAppContext().dataDir,
      threadId,
      designSessionId,
      core.code as SupportedCoreCode
    )
    const model = resolveCoreModel(core.code as SupportedCoreCode)

    const mcpSessionId = `plan-mcp-${randomUUID()}`
    const referenceManifest = await loadDesignReferenceManifest(designSessionId)

    plannerSession = {
      sessionId: mcpSessionId,
      jobId: designSessionId,
      threadId,
      runId: run.runId,
      ownerKind: 'thread_job',
      ownerId: designSessionId,
      allowedAbilityCodes: planningDraft.abilities.map((ability) => ability.abilityCode),
      validReferenceIds:
        referenceManifest?.references.map((item) => item.id) ??
        planningDraft.references.map((item) => item.id),
      referenceManifest,
      taskContexts: new Map(),
      planOutline: null,
      phaseAdvance,
      planRevision: revisionBefore + 1,
      clearConfirmed: Boolean(options?.regenerationInstruction),
      abortTurn: () => {
        const controller = getRunController(run.runId)
        if (controller && !controller.signal.aborted) {
          try {
            controller.abort('finalize_plan')
          } catch {
            // ignore
          }
        }
      },
      onPlanOutlineRegistered: async () => {
        const outline = plannerSession!.planOutline!
        const partial = flattenRegisteredPlan(outline, plannerSession!.taskContexts)
        await pushDesignPlanningProgress(designSessionId, run.runId, 0, partial, outline)
      },
      onTaskContextRegistered: async (_key, done) => {
        const outline = plannerSession!.planOutline!
        const partial = flattenRegisteredPlan(outline, plannerSession!.taskContexts)
        await pushDesignPlanningProgress(designSessionId, run.runId, done, partial, outline)
      }
    }

    const session = plannerSession
    registerPlannerMcpSession(session)

    plannerSandboxDebug('runDesignPlanner: mcp session registered', {
      designSessionId,
      runId: run.runId,
      mcpSessionId,
      ...summarizePlannerSession(session),
      validReferenceIds: session.validReferenceIds.length,
      hasReferenceManifest: Boolean(referenceManifest)
    })

    let mcpUrl: string | undefined
    try {
      mcpUrl = buildPlannerMcpUrl({ sessionId: mcpSessionId, jobId: designSessionId })
    } catch (error) {
      unregisterPlannerMcpSession(mcpSessionId)
      throw createTurnError('plan.mcp_unavailable', {
        detail: error instanceof Error ? error.message : String(error)
      })
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
        runId: run.runId,
        provider: core.code,
        model,
        promptChars: (plannerPrompt + regenerationSection).length,
        readRoots: plannerReadRoots.length,
        mcpUrl: Boolean(mcpUrl)
      })

      let chunkCount = 0
      await runWithExecutionRunContext({ runId: run.runId, signal: run.signal }, async () => {
        for await (const chunk of streamAgentTurn({
          role: 'planner',
          capabilityProfile: 'planner-read',
          provider: core.code as SupportedCoreCode,
          workspaceRoot: workspacePath,
          runtimeRoot,
          prompt: plannerPrompt + regenerationSection,
          model,
          systemPrompt: resolvePlannerPromptBody(),
          mcpUrl,
          readRoots: plannerReadRoots.length > 0 ? plannerReadRoots : undefined,
          signal: run.signal,
          jobId: plannerScopeId
        })) {
          chunkCount += 1
          if (chunk.type !== 'thinking_delta' && chunk.type !== 'delta') {
            plannerSandboxDebug('runDesignPlanner: turn chunk', {
              designSessionId,
              runId: run.runId,
              chunkType: chunk.type,
              chunkCount
            })
          }
          if (chunk.type === 'completed') break
          if (getAppContext().runtimeRegistry.shouldStopPlanning(designSessionId)) {
            getRunController(run.runId)?.abort()
            runOutcome = 'user_stopped'
            break
          }
        }
      })

      if (await commitPlanningSoftPause(designSessionId, designRunId)) {
        return
      }

      plannerSandboxDebug('runDesignPlanner: streamAgentTurn finished', {
        designSessionId,
        runId: run.runId,
        chunkCount,
        ...summarizePlannerSession(session),
        planCommitted
      })
    } finally {
      unregisterPlannerMcpSession(mcpSessionId)
      plannerSandboxDebug('runDesignPlanner: mcp session unregistered', {
        designSessionId,
        mcpSessionId
      })
    }

    await session.finalizerPromise

    if (session.planCommitted) {
      planCommitted = true
      await finishPlannerRun(designRunId, {
        status: 'completed',
        planRevisionAfter: session.planRevision
      })
      plannerSandboxDebug('runDesignPlanner: done (plan committed during stream)', {
        designSessionId
      })
      return
    }

    if (session.finalizerError) {
      throw session.finalizerError
    }
    plannerSandboxDebug('runDesignPlanner: failed (no finalize_plan)', {
      designSessionId,
      ...summarizePlannerSession(session)
    })
    throw createTurnError('draft.plan_not_ready', {
      detail: 'Planner did not finalize the structured plan via finalize_plan'
    })
  } catch (error) {
    if (isPlannerPlanCommitted(planCommitted, plannerSession)) {
      planCommitted = true
      runOutcome = 'success'
      if (plannerSession?.planCommitted) {
        await finishPlannerRun(designRunId, {
          status: 'completed',
          planRevisionAfter: plannerSession.planRevision
        })
      }
      plannerSandboxDebug('runDesignPlanner: done (plan committed, turn ended)', {
        designSessionId,
        runId: run.runId,
        errorCode:
          error instanceof Error && 'code' in error
            ? ((error as { code?: string }).code ?? null)
            : null
      })
      return
    }

    const turnError =
      error instanceof Error && 'code' in error
        ? (error as { code?: string; message?: string; detail?: string | null })
        : null
    plannerSandboxDebug('runDesignPlanner: failed', {
      designSessionId,
      runId: run.runId,
      errorCode: turnError?.code ?? null,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorDetail: turnError?.detail ?? null,
      ...(plannerSession ? summarizePlannerSession(plannerSession) : {})
    })

    const { getUserDesignSessionAsJob } = await import('./service')
    const current = await getUserDesignSessionAsJob(username, designSessionId)
    if (getAppContext().runtimeRegistry.shouldStopPlanning(designSessionId)) {
      runOutcome = 'user_stopped'
      if (await commitPlanningSoftPause(designSessionId, designRunId)) return
    }
    if (current?.status === 'cancelled') {
      await finishPlannerRun(designRunId, { status: 'cancelled' })
      runOutcome = 'user_stopped'
      return
    }

    runOutcome = 'failure'
    const failure = planFailureFromSandboxError(error)
    const job = await updateDesignSessionRowFenced(designSessionId, run.runId, {
      status: 'failed',
      planProgress: failure.planProgress,
      lastError: failure.lastError
    })
    await finishPlannerRun(designRunId, {
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
    plannerSandboxDebug('runDesignPlanner: releasing slot', {
      designSessionId,
      runId: run.runId,
      outcome: runOutcome
    })
    const { finishPlanningRunLifecycle } = await import('../legacy-control-plane/run-lifecycle')
    await finishPlanningRunLifecycle(run.runId, 'design_planning_done', runOutcome)
    // Provider close must finish before admitting another exclusive writer; planner no longer
    // holds an exclusive lease, but release remains idempotent for any leftover row.
    releaseWorkspaceLeaseForOwner('planner', designSessionId, run.runId)
    getAppContext().runtimeRegistry.endJobPlanning(designSessionId)
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

async function startDesignSessionPlanningRow(
  username: string,
  row: typeof threadJobs.$inferSelect
): Promise<void> {
  if (!row) return

  // User-paused planning wait uses the same planStatus=pending; do not auto-restart.
  if (row.lastError) {
    try {
      const parsed = JSON.parse(row.lastError) as { code?: string }
      if (parsed?.code === 'job.paused') return
    } catch {
      // ignore malformed lastError
    }
  }

  const { getMessage } = await import('../conversation/messages')
  const message = await getMessage(username, row.threadId, row.draftMessageId, {
    signAssets: false
  })
  if (!message || message.kind !== 'task-launch-draft') return
  const payload = message.payload as TaskLaunchDraftPayload | undefined
  if (!payload?.draftId) return

  const planProgress: PlanProgressDto = {
    ...defaultPlanProgress(),
    phase: 'planning',
    status: 'running',
    progressCode: 'plan.planning',
    progressParams: null,
    message: null
  }
  const updated = await updateDesignSessionRow(row.id, {
    status: 'planning',
    phase: 'plan_generating',
    planProgress
  })
  if (updated) {
    emitJobEvent(row.id, { event: 'plan_progress', data: { planProgress } })
    emitJobEvent(row.id, { event: 'job_snapshot', data: { job: updated } })
  }

  const { getThreadRow } = await import('../threads/service')
  const threadRow = await getThreadRow(username, row.threadId)
  if (!threadRow) return

  scheduleDesignSessionPlanning(
    username,
    row.threadId,
    row.id,
    payload,
    row.workspacePath,
    threadRow.coreCode
  )
}

export async function tryStartDesignSessionPlanning(
  username: string,
  designSessionId: string
): Promise<void> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(
      and(
        eq(threadJobs.id, designSessionId),
        eq(threadJobs.username, username),
        eq(threadJobs.status, 'planning'),
        eq(threadJobs.planStatus, 'pending'),
        isNull(threadJobs.activeRunId)
      )
    )
    .limit(1)

  const row = rows[0]
  if (!row) return
  await startDesignSessionPlanningRow(username, row)
}

export async function tryStartPendingDesignSessionPlanning(username: string): Promise<void> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(
      and(
        eq(threadJobs.username, username),
        eq(threadJobs.status, 'planning'),
        eq(threadJobs.planStatus, 'pending'),
        isNull(threadJobs.activeRunId)
      )
    )
    .orderBy(asc(threadJobs.updatedAt))
    .limit(1)

  const row = rows[0]
  if (!row) return
  await startDesignSessionPlanningRow(username, row)
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
): Promise<import('../legacy-control-plane/types').ThreadJobDto> {
  const { getUserDesignSessionAsJob } = await import('./service')
  const session = await getUserDesignSessionAsJob(username, designSessionId)
  if (!session) throw AppError.notFound('Design session not found', 'design_session.not_found')
  if (!['failed', 'cancelled', 'paused', 'plan_editing', 'planning'].includes(session.status)) {
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
