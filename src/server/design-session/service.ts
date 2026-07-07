import { randomUUID } from 'crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { parseJobReferenceManifest, toPublicReferenceManifest } from '@shared/job-references'
import { isDesignSessionId } from '@shared/design-session'
import { hydrateTurnErrorField, coercePersistedTurnError } from '../turn-errors/store'
import type { TurnErrorDto } from '../../shared/turn-errors.ts'
import { getDb } from '../db'
import {
  copyDesignPlanToJob,
  loadDesignAbilities,
  loadDesignPlan,
  loadDesignPlanProgress,
  saveDesignPlan,
  saveDesignPlanInTx,
  saveDesignPlanProgress
} from '../db/design-plan'
import { savePlanProgress } from '../db/job-plan'
import { saveTaskProgress } from '../db/job-progress'
import { designRuns, designSessions, threadJobs, threads, type DesignSession } from '../db/schema'
import type { PlanProgressDto, TaskProgressDto, ThreadJobDto } from '../jobs/types'
import type { SavedJobPlan } from '../planner/plan-types'
import { defaultTaskProgress } from '../planner/save-plan'
import { mapJob } from '../jobs/repository'
import { AppError } from '../error'
import { ReferenceFileMissingError } from '../jobs/reference-paths'
import { buildJobSnapshot, parseSessionManifest, validateLaunchPreconditions } from './launch'
import { advanceWorkloadQueue } from '../jobs/workload-slot-store'
import { emitJobEvent } from '../jobs/service'
import { DESIGN_SESSION_WORKSPACE_STATUSES } from '@shared/design-session'
import { isManifestFresh } from '../reference-corpus/corpus-sync'

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
}>

export async function getDesignSessionRow(designSessionId: string): Promise<DesignSession | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(designSessions)
    .where(eq(designSessions.id, designSessionId))
    .limit(1)
  return rows[0] ?? null
}

export async function mapDesignSessionToJobDto(
  row: DesignSession,
  options?: { includePlan?: boolean }
): Promise<ThreadJobDto> {
  const db = getDb()
  const includePlan = options?.includePlan ?? true
  const [abilities, planProgress, plan] = await Promise.all([
    loadDesignAbilities(db, row.id),
    loadDesignPlanProgress(db, row.id),
    includePlan ? loadDesignPlan(db, row.id) : Promise.resolve(null)
  ])
  const taskProgress: TaskProgressDto = {
    phase: row.taskPhase as TaskProgressDto['phase'],
    status: row.taskStatus as TaskProgressDto['status'],
    currentIndex: row.taskCurrentIndex,
    total: row.taskTotal,
    currentTaskId: row.taskCurrentTaskId ?? null,
    message: row.taskMessage,
    tasks: []
  }
  const manifest = parseJobReferenceManifest(row.referenceManifestJson)
  return {
    id: row.id,
    threadId: row.threadId,
    draftMessageId: row.draftMessageId,
    title: row.title,
    summary: row.summary ?? '',
    status: row.status as ThreadJobDto['status'],
    planProgress,
    taskProgress,
    abilities,
    plan: includePlan ? (plan ?? undefined) : undefined,
    referenceManifest: manifest ? toPublicReferenceManifest(manifest) : undefined,
    referenceManifestStale: !isManifestFresh(row),
    planRevision: row.planRevision,
    workspacePath: row.workspaceRoot,
    lastError: hydrateTurnErrorField(row.lastError),
    draftConfirmedAt: row.draftConfirmedAt ?? null,
    planConfirmedAt: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export async function getDesignSessionAsJob(
  username: string,
  threadId: string,
  designSessionId: string
): Promise<ThreadJobDto | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(designSessions)
    .where(
      and(
        eq(designSessions.id, designSessionId),
        eq(designSessions.threadId, threadId),
        eq(designSessions.username, username)
      )
    )
    .limit(1)
  return rows[0] ? mapDesignSessionToJobDto(rows[0], { includePlan: true }) : null
}

export async function getUserDesignSessionAsJob(
  username: string,
  designSessionId: string
): Promise<ThreadJobDto | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(designSessions)
    .where(and(eq(designSessions.id, designSessionId), eq(designSessions.username, username)))
    .limit(1)
  return rows[0] ? mapDesignSessionToJobDto(rows[0], { includePlan: true }) : null
}

export async function listThreadDesignSessions(
  username: string,
  threadId: string
): Promise<ThreadJobDto[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(designSessions)
    .where(
      and(
        eq(designSessions.threadId, threadId),
        eq(designSessions.username, username),
        inArray(designSessions.status, [...DESIGN_SESSION_WORKSPACE_STATUSES])
      )
    )
    .orderBy(desc(designSessions.updatedAt))

  return Promise.all(rows.map((row) => mapDesignSessionToJobDto(row, { includePlan: true })))
}

export async function updateDesignSessionRow(
  designSessionId: string,
  patch: DesignSessionRowPatch,
  options?: { includePlan?: boolean }
): Promise<ThreadJobDto | null> {
  const db = getDb()
  const now = nowSec()
  const { plan, planProgress, taskProgress, lastError, ...rowPatch } = patch

  const dbPatch: Record<string, unknown> = { ...rowPatch, updatedAt: now }
  if (lastError !== undefined) {
    dbPatch.lastError = coercePersistedTurnError(lastError)
  }

  if (Object.keys(dbPatch).length > 1) {
    await db.update(designSessions).set(dbPatch).where(eq(designSessions.id, designSessionId))
  }

  if (plan !== undefined) {
    await saveDesignPlan(db, designSessionId, plan)
    await db
      .update(designSessions)
      .set({ updatedAt: now })
      .where(eq(designSessions.id, designSessionId))
  }

  if (planProgress) {
    await saveDesignPlanProgress(db, designSessionId, planProgress)
    await db
      .update(designSessions)
      .set({ updatedAt: now })
      .where(eq(designSessions.id, designSessionId))
  }

  if (taskProgress) {
    await db
      .update(designSessions)
      .set({
        taskPhase: taskProgress.phase,
        taskStatus: taskProgress.status,
        taskCurrentIndex: taskProgress.currentIndex,
        taskTotal: taskProgress.total,
        taskCurrentTaskId: taskProgress.currentTaskId ?? null,
        taskMessage: taskProgress.message ?? null,
        updatedAt: now
      })
      .where(eq(designSessions.id, designSessionId))
  }

  const rows = await db
    .select()
    .from(designSessions)
    .where(eq(designSessions.id, designSessionId))
    .limit(1)
  return rows[0]
    ? mapDesignSessionToJobDto(rows[0], { includePlan: options?.includePlan ?? true })
    : null
}

export async function updateDesignSessionRowFenced(
  designSessionId: string,
  runId: string,
  patch: DesignSessionRowPatch,
  options?: { includePlan?: boolean }
): Promise<ThreadJobDto | null> {
  const db = getDb()
  const fence = and(
    eq(designSessions.id, designSessionId),
    eq(designSessions.activeRunId, runId)
  )!

  const applied = db.transaction((tx) => {
    const existing = tx.select().from(designSessions).where(fence).limit(1).all()[0]
    if (!existing) return false

    const now = nowSec()
    const { plan, planProgress, taskProgress, lastError, ...rowPatch } = patch

    const dbPatch: Record<string, unknown> = { ...rowPatch, updatedAt: now }
    if (lastError !== undefined) {
      dbPatch.lastError = coercePersistedTurnError(lastError)
    }

    if (Object.keys(dbPatch).length > 1) {
      const result = tx.update(designSessions).set(dbPatch).where(fence).run()
      if (result.changes === 0) return false
    }

    if (plan !== undefined) {
      saveDesignPlanInTx(tx, designSessionId, plan)
      tx.update(designSessions).set({ updatedAt: now }).where(fence).run()
    }

    if (planProgress) {
      const counts = {
        milestones: planProgress.milestones,
        slices: planProgress.slices,
        tasks: planProgress.tasks
      }
      tx.update(designSessions)
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
      tx.update(designSessions).set({ updatedAt: now }).where(fence).run()
    }

    if (taskProgress) {
      tx.update(designSessions)
        .set({
          taskPhase: taskProgress.phase,
          taskStatus: taskProgress.status,
          taskCurrentIndex: taskProgress.currentIndex,
          taskTotal: taskProgress.total,
          taskCurrentTaskId: taskProgress.currentTaskId ?? null,
          taskMessage: taskProgress.message ?? null,
          updatedAt: now
        })
        .where(fence)
        .run()
    }

    return tx.select().from(designSessions).where(fence).limit(1).all()[0] != null
  })

  if (!applied) return null

  const rows = await db
    .select()
    .from(designSessions)
    .where(eq(designSessions.id, designSessionId))
    .limit(1)
  return rows[0]
    ? mapDesignSessionToJobDto(rows[0], { includePlan: options?.includePlan ?? true })
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
    planRevisionAfter?: number
    error?: string
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
  const { ensureStartupWorkloadReady } = await import('../jobs/workload-slot')
  await ensureStartupWorkloadReady()

  const db = getDb()
  const sessionRows = await db
    .select()
    .from(designSessions)
    .where(
      and(
        eq(designSessions.id, designSessionId),
        eq(designSessions.threadId, threadId),
        eq(designSessions.username, username)
      )
    )
    .limit(1)
  const session = sessionRows[0]
  if (!session) throw AppError.notFound('Design session not found', 'job.not_found')

  const [plan, abilities] = await Promise.all([
    loadDesignPlan(db, designSessionId),
    loadDesignAbilities(db, designSessionId)
  ])
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

  const snapshot = buildJobSnapshot({
    session,
    plan: plan!,
    abilities,
    manifest: manifest!
  })

  const jobId = `job-${randomUUID()}`
  const confirmedAt = nowSec()
  const planProgress: PlanProgressDto = {
    phase: 'plan_ready',
    status: 'completed',
    contextsRegistered: snapshot.executionPlan.tasks.length,
    contextsTotal: snapshot.executionPlan.tasks.length,
    milestones: snapshot.executionPlan.milestones.length,
    slices: snapshot.executionPlan.milestones.reduce((n, m) => n + m.slices.length, 0),
    tasks: snapshot.executionPlan.tasks.length,
    progressCode: 'plan.plan_ready',
    progressParams: { tasks: snapshot.executionPlan.tasks.length },
    message: null
  }
  const taskProgress = defaultTaskProgress(snapshot.executionPlan.tasks)

  await db.insert(threadJobs).values({
    id: jobId,
    threadId,
    username,
    draftMessageId: session.draftMessageId,
    title: session.title,
    summary: session.summary ?? '',
    status: 'pending',
    workspacePath: snapshot.workspaceRoot,
    planPhase: planProgress.phase,
    planStatus: planProgress.status,
    planContextsRegistered: planProgress.contextsRegistered,
    planContextsTotal: planProgress.contextsTotal,
    planMessage: planProgress.message ?? null,
    planCountsJson: JSON.stringify({
      milestones: planProgress.milestones,
      slices: planProgress.slices,
      tasks: planProgress.tasks
    }),
    taskPhase: taskProgress.phase,
    taskStatus: taskProgress.status,
    taskCurrentIndex: taskProgress.currentIndex,
    taskTotal: taskProgress.total,
    taskCurrentTaskId: taskProgress.currentTaskId ?? null,
    taskMessage: taskProgress.message ?? null,
    taskMetaJson: '{}',
    lastError: null,
    referenceManifestJson: session.referenceManifestJson,
    draftConfirmedAt: session.draftConfirmedAt ?? confirmedAt,
    planConfirmedAt: confirmedAt,
    designSessionId: snapshot.designSessionId,
    snapshotDraftRevision: snapshot.draftRevision,
    snapshotPlanRevision: snapshot.planRevision,
    snapshotManifestRevision: snapshot.manifestRevision,
    createdAt: confirmedAt,
    updatedAt: confirmedAt
  })

  await copyDesignPlanToJob(db, designSessionId, jobId)
  await savePlanProgress(db, jobId, planProgress)
  await saveTaskProgress(db, jobId, taskProgress)

  await db
    .update(designSessions)
    .set({
      status: 'launched',
      phase: 'archived',
      launchedJobId: jobId,
      updatedAt: confirmedAt
    })
    .where(eq(designSessions.id, designSessionId))

  const { updateMessagePayload, getMessage } = await import('../conversation/messages')
  const draftMessage = await getMessage(username, threadId, session.draftMessageId, {
    signAssets: false
  })
  if (draftMessage?.payload) {
    const payload = draftMessage.payload as Record<string, unknown>
    await updateMessagePayload(username, threadId, session.draftMessageId, {
      ...payload,
      linkedPlanId: jobId,
      designSessionId
    })
  }

  await db
    .update(threads)
    .set({ activePlanId: jobId, updatedAt: confirmedAt })
    .where(and(eq(threads.id, threadId), eq(threads.username, username)))

  const jobRows = await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1)
  const job = jobRows[0] ? await mapJob(jobRows[0], { includePlan: true }) : null
  if (!job) throw AppError.internal('Failed to create job', 'turn.unknown')

  emitJobEvent(jobId, { event: 'task_progress', data: { taskProgress } })
  emitJobEvent(jobId, { event: 'job_snapshot', data: { job } })

  if (!options?.skipQueueAdvance) {
    await advanceWorkloadQueue(username)
  }
  return job
}

export { isDesignSessionId }
