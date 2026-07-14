import { randomUUID } from 'crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { parseJobReferenceManifest } from '@shared/job-references'
import { isDesignSessionId, DESIGN_SESSION_WORKSPACE_STATUSES } from '@shared/design-session'
import { coercePersistedTurnError } from '../turn-errors/store'
import type { TurnErrorDto } from '../../shared/turn-errors.ts'
import { getDb } from '../db'
import { loadJobAbilitiesInTx, loadJobPlan, loadJobPlanInTx, saveJobPlanInTx } from '../db/job-plan'
import { saveTaskProgressInTx } from '../db/job-progress'
import { designRuns, threadJobs, threadMessages, threads, type ThreadJob } from '../db/schema'
import type { PlanProgressDto, TaskProgressDto, ThreadJobDto } from '../legacy-control-plane/types'
import type { SavedJobPlan } from '../planner/plan-types'
import { defaultTaskProgress } from '../planner/save-plan'
import { mapJob } from '../legacy-control-plane/repository'
import { AppError } from '../error'
import { ReferenceFileMissingError } from '../legacy-control-plane/reference-paths'
import {
  assertConfirmRevisionMatches,
  buildJobSnapshot,
  captureConfirmRevisionExpectations,
  parseSessionManifest,
  validateLaunchPreconditions
} from './launch'
import { advanceWorkloadQueue } from '../legacy-control-plane/workload-slot-store'
import { emitJobEvent } from '../legacy-control-plane/service'

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export type DesignSessionRowPatch = Partial<{
  status: string
  phase: string
  planRevision: number
  plan: SavedJobPlan | null
  planProgress: PlanProgressDto
  taskProgress: TaskProgressDto
  lastError: TurnErrorDto | string | null
  launchedJobId: string | null
  planArtifactId: string | null
  planArtifactPath: string | null
  planSummaryJson: string | null
}>

export async function getDesignSessionRow(designSessionId: string): Promise<ThreadJob | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(eq(threadJobs.id, designSessionId))
    .limit(1)
  return rows[0] ?? null
}

export async function getDesignSessionAsJob(
  username: string,
  threadId: string,
  designSessionId: string
): Promise<ThreadJobDto | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(
      and(
        eq(threadJobs.id, designSessionId),
        eq(threadJobs.threadId, threadId),
        eq(threadJobs.username, username)
      )
    )
    .limit(1)
  return rows[0] ? mapJob(rows[0], { includePlan: true }) : null
}

export async function getUserDesignSessionAsJob(
  username: string,
  designSessionId: string
): Promise<ThreadJobDto | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(and(eq(threadJobs.id, designSessionId), eq(threadJobs.username, username)))
    .limit(1)
  return rows[0] ? mapJob(rows[0], { includePlan: true }) : null
}

export async function listThreadDesignSessions(
  username: string,
  threadId: string
): Promise<ThreadJobDto[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(
      and(
        eq(threadJobs.threadId, threadId),
        eq(threadJobs.username, username),
        inArray(threadJobs.status, [...DESIGN_SESSION_WORKSPACE_STATUSES])
      )
    )
    .orderBy(desc(threadJobs.updatedAt))

  return Promise.all(rows.map((row) => mapJob(row, { includePlan: true })))
}

export async function updateDesignSessionRow(
  designSessionId: string,
  patch: DesignSessionRowPatch,
  options?: { includePlan?: boolean }
): Promise<ThreadJobDto | null> {
  const db = getDb()
  const now = nowSec()
  const { plan, planProgress, taskProgress, lastError, launchedJobId: _launchedJobId, ...rowPatch } =
    patch

  const dbPatch: Record<string, unknown> = { ...rowPatch, updatedAt: now }
  if (lastError !== undefined) {
    dbPatch.lastError = coercePersistedTurnError(lastError)
  }

  db.transaction(() => {
    if (Object.keys(dbPatch).length > 1) {
      db.update(threadJobs).set(dbPatch).where(eq(threadJobs.id, designSessionId)).run()
    }

    if (plan !== undefined) {
      saveJobPlanInTx(db, designSessionId, plan)
      db.update(threadJobs).set({ updatedAt: now }).where(eq(threadJobs.id, designSessionId)).run()
    }

    if (planProgress) {
      const counts = {
        milestones: planProgress.milestones,
        slices: planProgress.slices,
        tasks: planProgress.tasks
      }
      db.update(threadJobs)
        .set({
          planPhase: planProgress.phase,
          planStatus: planProgress.status,
          planContextsRegistered: planProgress.contextsRegistered,
          planContextsTotal: planProgress.contextsTotal,
          planMessage: planProgress.message ?? null,
          planCountsJson: JSON.stringify(counts),
          updatedAt: now
        })
        .where(eq(threadJobs.id, designSessionId))
        .run()
    }

    if (taskProgress) {
      saveTaskProgressInTx(db, designSessionId, taskProgress, eq(threadJobs.id, designSessionId))
      db.update(threadJobs).set({ updatedAt: now }).where(eq(threadJobs.id, designSessionId)).run()
    }
  })

  const rows = db.select().from(threadJobs).where(eq(threadJobs.id, designSessionId)).limit(1).all()
  return rows[0]
    ? mapJob(rows[0], { includePlan: options?.includePlan ?? true })
    : null
}

export async function updateDesignSessionRowFenced(
  designSessionId: string,
  runId: string,
  patch: DesignSessionRowPatch,
  options?: { includePlan?: boolean }
): Promise<ThreadJobDto | null> {
  const db = getDb()
  const fence = and(eq(threadJobs.id, designSessionId), eq(threadJobs.activeRunId, runId))!

  const applied = db.transaction((tx) => {
    const existing = tx.select().from(threadJobs).where(fence).limit(1).all()[0]
    if (!existing) return false

    const now = nowSec()
    const { plan, planProgress, taskProgress, lastError, launchedJobId: _launchedJobId, ...rowPatch } =
      patch

    const dbPatch: Record<string, unknown> = { ...rowPatch, updatedAt: now }
    if (lastError !== undefined) {
      dbPatch.lastError = coercePersistedTurnError(lastError)
    }

    if (Object.keys(dbPatch).length > 1) {
      const result = tx.update(threadJobs).set(dbPatch).where(fence).run()
      if (result.changes === 0) return false
    }

    if (plan !== undefined) {
      saveJobPlanInTx(tx, designSessionId, plan)
      tx.update(threadJobs).set({ updatedAt: now }).where(fence).run()
    }

    if (planProgress) {
      const counts = {
        milestones: planProgress.milestones,
        slices: planProgress.slices,
        tasks: planProgress.tasks
      }
      tx.update(threadJobs)
        .set({
          planPhase: planProgress.phase,
          planStatus: planProgress.status,
          planContextsRegistered: planProgress.contextsRegistered,
          planContextsTotal: planProgress.contextsTotal,
          planMessage: planProgress.message ?? null,
          planCountsJson: JSON.stringify(counts)
        })
        .where(fence)
        .run()
      tx.update(threadJobs).set({ updatedAt: now }).where(fence).run()
    }

    if (taskProgress) {
      saveTaskProgressInTx(tx, designSessionId, taskProgress, fence)
      tx.update(threadJobs).set({ updatedAt: now }).where(fence).run()
    }

    return tx.select().from(threadJobs).where(fence).limit(1).all()[0] != null
  })

  if (!applied) return null

  const rows = await db
    .select()
    .from(threadJobs)
    .where(eq(threadJobs.id, designSessionId))
    .limit(1)
  return rows[0]
    ? mapJob(rows[0], { includePlan: options?.includePlan ?? true })
    : null
}

export async function createPlannerRun(input: {
  designSessionId: string
  planRevisionBefore?: number
  plannerSessionId?: string
}): Promise<string> {
  const runId = `drun-${randomUUID()}`
  const now = nowSec()
  const db = getDb()
  await db.insert(designRuns).values({
    id: runId,
    designSessionId: input.designSessionId,
    kind: 'planner',
    status: 'running',
    startedAt: now,
    plannerSessionId: input.plannerSessionId ?? null,
    planRevisionBefore: input.planRevisionBefore ?? null,
    planRevisionAfter: null,
    toolName: null,
    error: null
  })
  return runId
}

export async function finishPlannerRun(
  runId: string,
  input: {
    status: 'completed' | 'failed' | 'cancelled'
    planRevisionAfter?: number | undefined
    error?: string | undefined
  }
): Promise<void> {
  const db = getDb()
  await db
    .update(designRuns)
    .set({
      status: input.status,
      finishedAt: nowSec(),
      planRevisionAfter: input.planRevisionAfter ?? null,
      error: input.error ?? null
    })
    .where(eq(designRuns.id, runId))
}

export async function loadDesignReferenceManifest(
  designSessionId: string
): Promise<ReturnType<typeof parseJobReferenceManifest>> {
  const row = await getDesignSessionRow(designSessionId)
  if (!row) return null
  return parseJobReferenceManifest(row.referenceManifestJson)
}

export async function launchJobFromDesignSession(
  username: string,
  threadId: string,
  designSessionId: string,
  options?: { skipQueueAdvance?: boolean }
): Promise<ThreadJobDto> {
  const { ensureStartupWorkloadReady } = await import('../legacy-control-plane/workload-slot')
  await ensureStartupWorkloadReady()

  // FIX-PLAN F3-C (§8.4): reject new execution-tree confirms while draining for shutdown.
  const { isDraining } = await import('../legacy-control-plane/shutdown-state')
  if (isDraining()) {
    throw AppError.conflict(
      'Runtime is shutting down; cannot confirm execution tree',
      undefined,
      'runtime.draining'
    )
  }

  const db = getDb()
  const sessionRows = await db
    .select()
    .from(threadJobs)
    .where(
      and(
        eq(threadJobs.id, designSessionId),
        eq(threadJobs.threadId, threadId),
        eq(threadJobs.username, username)
      )
    )
    .limit(1)
  const session = sessionRows[0]
  if (!session) throw AppError.notFound('Design session not found', 'job.not_found')

  const plan = await loadJobPlan(db, designSessionId)
  const manifest = parseSessionManifest(session)

  try {
    validateLaunchPreconditions({ session, plan, manifest })
  } catch (error) {
    if (error instanceof ReferenceFileMissingError) {
      throw AppError.badRequest('Reference file missing', 'draft.reference_not_found', {
        referenceId: error.referenceId,
        referenceName: error.referenceName,
        path: error.relativePath
      })
    }
    throw error
  }

  const expectedRevisions = captureConfirmRevisionExpectations(session)
  const confirmedAt = nowSec()

  // F2 (§7.1): the draft message's linkedPlanId MUST be frozen in the SAME
  // transaction that makes the job executable. Prepare the payload columns
  // (async: strips asset tokens / externalizes) BEFORE opening the synchronous
  // transaction, then apply them atomically inside it.
  const { prepareMessagePayloadColumns, getMessage } = await import('../conversation/messages')
  const draftMessage = await getMessage(username, threadId, session.draftMessageId, {
    signAssets: false
  })
  let draftPayloadColumns:
    | { payloadJson: string | null; payloadArtifactId: string | null }
    | null = null
  if (draftMessage?.payload) {
    const payload = draftMessage.payload as Record<string, unknown>
    draftPayloadColumns = await prepareMessagePayloadColumns(session.draftMessageId, {
      ...payload,
      linkedPlanId: designSessionId,
      designSessionId
    })
  }

  // Single atomic confirm boundary: re-read session state inside the transaction,
  // CAS on owner/thread/status/revisions, freeze snapshot revisions, flip the job to
  // pending, write planConfirmedAt, clear old errors AND old lease, persist task
  // progress, link the draft message payload, and mark the thread's active plan.
  const txResult = db.transaction(() => {
    const currentRows = db
      .select()
      .from(threadJobs)
      .where(
        and(
          eq(threadJobs.id, designSessionId),
          eq(threadJobs.threadId, threadId),
          eq(threadJobs.username, username)
        )
      )
      .limit(1)
      .all()
    const current = currentRows[0]
    if (!current) return { ok: false as const }

    assertConfirmRevisionMatches(current, expectedRevisions)

    const currentPlan = loadJobPlanInTx(db, designSessionId)
    const currentAbilities = loadJobAbilitiesInTx(db, designSessionId)
    const currentManifest = parseSessionManifest(current)

    validateLaunchPreconditions({
      session: current,
      plan: currentPlan,
      manifest: currentManifest
    })

    const currentSnapshot = buildJobSnapshot({
      session: current,
      plan: currentPlan!,
      abilities: currentAbilities,
      manifest: currentManifest!
    })
    const currentPlanProgress: PlanProgressDto = {
      phase: 'plan_ready',
      status: 'completed',
      contextsRegistered: currentSnapshot.executionPlan.tasks.length,
      contextsTotal: currentSnapshot.executionPlan.tasks.length,
      milestones: currentSnapshot.executionPlan.milestones.length,
      slices: currentSnapshot.executionPlan.milestones.reduce((n, m) => n + m.slices.length, 0),
      tasks: currentSnapshot.executionPlan.tasks.length,
      progressCode: 'plan.plan_ready',
      progressParams: { tasks: currentSnapshot.executionPlan.tasks.length },
      message: null
    }
    const currentTaskProgress = defaultTaskProgress(currentSnapshot.executionPlan.tasks)
    const planCounts = {
      milestones: currentPlanProgress.milestones,
      slices: currentPlanProgress.slices,
      tasks: currentPlanProgress.tasks
    }

    const result = db
      .update(threadJobs)
      .set({
        status: 'pending',
        phase: 'archived',
        workspacePath: currentSnapshot.workspaceRoot,
        planPhase: currentPlanProgress.phase,
        planStatus: currentPlanProgress.status,
        planContextsRegistered: currentPlanProgress.contextsRegistered,
        planContextsTotal: currentPlanProgress.contextsTotal,
        planMessage: currentPlanProgress.message ?? null,
        planCountsJson: JSON.stringify(planCounts),
        draftConfirmedAt: current.draftConfirmedAt ?? confirmedAt,
        planConfirmedAt: confirmedAt,
        designSessionId: designSessionId,
        snapshotDraftRevision: currentSnapshot.draftRevision,
        snapshotPlanRevision: currentSnapshot.planRevision,
        snapshotManifestRevision: currentSnapshot.manifestRevision,
        lastError: null,
        // Clear any stale lease from a previous run so recovery/claim starts clean.
        executionLeaseOwner: null,
        executionLeaseExpiresAt: null,
        activeRunId: null,
        updatedAt: confirmedAt
      })
      .where(
        and(
          eq(threadJobs.id, designSessionId),
          eq(threadJobs.username, username),
          eq(threadJobs.threadId, threadId),
          eq(threadJobs.status, 'plan_editing'),
          isNull(threadJobs.planConfirmedAt),
          eq(threadJobs.draftRevision, expectedRevisions.draftRevision),
          eq(threadJobs.planRevision, expectedRevisions.planRevision),
          eq(threadJobs.manifestRevision, expectedRevisions.manifestRevision)
        )
      )
      .run()

    if (result.changes !== 1) return { ok: false as const }

    saveTaskProgressInTx(
      db,
      designSessionId,
      currentTaskProgress,
      eq(threadJobs.id, designSessionId)
    )

    if (draftPayloadColumns) {
      db.update(threadMessages)
        .set({
          payloadJson: draftPayloadColumns.payloadJson,
          payloadArtifactId: draftPayloadColumns.payloadArtifactId
        })
        .where(
          and(
            eq(threadMessages.id, current.draftMessageId),
            eq(threadMessages.threadId, threadId),
            eq(threadMessages.username, username)
          )
        )
        .run()
    }

    db.update(threads)
      .set({ activePlanId: designSessionId, updatedAt: confirmedAt })
      .where(and(eq(threads.id, threadId), eq(threads.username, username)))
      .run()

    return {
      ok: true as const,
      taskProgress: currentTaskProgress,
      planProgress: currentPlanProgress
    }
  })

  if (!txResult.ok) {
    throw AppError.conflict(
      'Plan changed while it was being confirmed',
      undefined,
      'plan.confirm_conflict'
    )
  }

  const { taskProgress } = txResult

  const jobRows = db
    .select()
    .from(threadJobs)
    .where(eq(threadJobs.id, designSessionId))
    .limit(1)
    .all()
  const job = jobRows[0] ? await mapJob(jobRows[0], { includePlan: true }) : null
  if (!job) throw AppError.internal('Failed to launch job', 'turn.unknown')

  emitJobEvent(designSessionId, { event: 'task_progress', data: { taskProgress } })
  emitJobEvent(designSessionId, { event: 'job_snapshot', data: { job } })

  // F2 (§7.1): queue advance happens strictly AFTER commit. If it fails the job
  // stays pending for the reconciler / next startup to pick up — never roll back
  // a committed confirmation.
  if (!options?.skipQueueAdvance) {
    try {
      await advanceWorkloadQueue(username)
    } catch (error) {
      console.warn(
        '[design-session] advance queue after confirm failed; job stays pending',
        designSessionId,
        error
      )
    }
    const latestRows = db
      .select()
      .from(threadJobs)
      .where(eq(threadJobs.id, designSessionId))
      .limit(1)
      .all()
    if (latestRows[0]) {
      return mapJob(latestRows[0], { includePlan: true })
    }
  }
  return job
}

export { isDesignSessionId }
