import { randomUUID } from 'crypto'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { parseJobReferenceManifest } from '@shared/job-references'
import { isDesignSessionId, DESIGN_SESSION_WORKSPACE_STATUSES } from '@shared/design-session'
import { coercePersistedTurnError } from '../turn-errors/store'
import type { TurnErrorDto } from '../../shared/turn-errors.ts'
import { getDb } from '../db'
import { loadJobAbilitiesInTx, loadJobPlan, loadJobPlanInTx, saveJobPlanInTx } from '../db/job-plan'
import { saveTaskProgressInTx } from '../db/job-progress'
import {
  deletionRequests,
  designRuns,
  jobAbilities,
  threadJobs,
  threadMessages,
  threads,
  type ThreadJob
} from '../db/schema'
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
import { putDesignPlanRevisionInTx } from '../retention/design-plan-artifacts'
import { stageJobReferenceAssets } from '../legacy-control-plane/job-reference-assets'
import { THREAD_KIND_TASK_SNAPSHOT } from '../threads/types'
import { stripAssetUrlAuthTokensInValue } from '../auth/sign-asset-url'

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
  const rows = await db.select().from(threadJobs).where(eq(threadJobs.id, designSessionId)).limit(1)
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
  const {
    plan,
    planProgress,
    taskProgress,
    lastError,
    launchedJobId: _launchedJobId,
    ...rowPatch
  } = patch

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
      if (plan && patch.planRevision && patch.planRevision > 0) {
        const artifact = putDesignPlanRevisionInTx(db, {
          jobId: designSessionId,
          planRevision: patch.planRevision,
          plan
        })
        db.update(threadJobs)
          .set({
            planArtifactId: artifact.artifactId,
            planArtifactPath: artifact.contentPath,
            planSummaryJson: artifact.summaryJson
          })
          .where(eq(threadJobs.id, designSessionId))
          .run()
      }
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
  return rows[0] ? mapJob(rows[0], { includePlan: options?.includePlan ?? true }) : null
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
    const {
      plan,
      planProgress,
      taskProgress,
      lastError,
      launchedJobId: _launchedJobId,
      ...rowPatch
    } = patch

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
      if (plan && patch.planRevision && patch.planRevision > 0) {
        const artifact = putDesignPlanRevisionInTx(tx, {
          jobId: designSessionId,
          planRevision: patch.planRevision,
          plan
        })
        tx.update(threadJobs)
          .set({
            planArtifactId: artifact.artifactId,
            planArtifactPath: artifact.contentPath,
            planSummaryJson: artifact.summaryJson
          })
          .where(fence)
          .run()
      }
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

  const rows = await db.select().from(threadJobs).where(eq(threadJobs.id, designSessionId)).limit(1)
  return rows[0] ? mapJob(rows[0], { includePlan: options?.includePlan ?? true }) : null
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

  if (session.status === 'published' && session.phase === 'archived') {
    const publishedTask = db
      .select()
      .from(threadJobs)
      .where(
        and(
          eq(threadJobs.username, username),
          eq(threadJobs.designSessionId, designSessionId),
          isNotNull(threadJobs.planConfirmedAt)
        )
      )
      .limit(1)
      .all()[0]
    if (publishedTask) return mapJob(publishedTask, { includePlan: true })
  }

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
  const taskJobId = `job-${randomUUID()}`
  const taskThreadId = `task-${randomUUID()}`
  const taskDraftMessageId = `msg-${randomUUID()}`
  const taskConversationId = `task-conv-${taskJobId}`

  // Publication is a copy boundary. The source draft/design session remains owned by
  // the draft conversation; execution gets a fresh Job id plus a hidden, task-owned
  // snapshot container. No executable row points back to the source thread/message.
  const { prepareMessagePayloadColumns, getMessage } = await import('../conversation/messages')
  const draftMessage = await getMessage(username, threadId, session.draftMessageId, {
    signAssets: false
  })
  if (!draftMessage?.payload) {
    throw AppError.notFound('Draft message not found', 'draft.not_found')
  }
  const sourceThread = db
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.username, username)))
    .limit(1)
    .all()[0]
  if (!sourceThread) throw AppError.notFound('Thread not found', 'thread.not_found')

  const sourceDraftPayload = draftMessage.payload as Record<string, unknown>
  const sourceDraftPayloadColumns = await prepareMessagePayloadColumns(session.draftMessageId, {
    ...sourceDraftPayload,
    linkedPlanId: taskJobId,
    launchedJobId: taskJobId,
    designSessionId
  })
  // The snapshot message does not exist until the publication transaction, so it
  // cannot use message_artifacts (which has an FK to thread_messages) beforehand.
  // Keep this internal immutable snapshot inline; it is deleted with the task owner.
  const taskSnapshotPayloadJson = JSON.stringify(
    stripAssetUrlAuthTokensInValue({
      ...sourceDraftPayload,
      linkedPlanId: taskJobId,
      launchedJobId: taskJobId,
      designSessionId,
      references: [],
      sourceAttachments: [],
      snapshot: {
        sourceThreadId: threadId,
        sourceDraftMessageId: session.draftMessageId,
        sourceDesignSessionId: designSessionId,
        publishedAt: confirmedAt
      }
    })
  )

  // Stage task-owned copies under the task snapshot thread before the publication CAS.
  const stagedAssets = await stageJobReferenceAssets({
    jobId: taskJobId,
    sourceThreadId: threadId,
    targetThreadId: taskThreadId,
    manifest: manifest!
  }).catch((error) => {
    if (error instanceof ReferenceFileMissingError) {
      throw AppError.badRequest('Reference file missing', 'draft.reference_not_found', {
        referenceId: error.referenceId,
        referenceName: error.referenceName,
        path: error.relativePath
      })
    }
    throw error
  })

  // Single atomic publication boundary: CAS the design session, create the hidden
  // task snapshot container, then deep-copy the executable plan and abilities.
  let txResult:
    | {
        ok: true
        taskProgress: TaskProgressDto
        planProgress: PlanProgressDto
      }
    | { ok: false; reason: 'conflict' | 'deleting' }

  try {
    txResult = db.transaction(() => {
      const activeDeletion = db
        .select({ id: deletionRequests.id })
        .from(deletionRequests)
        .where(
          and(
            eq(deletionRequests.entityKind, 'thread_job'),
            eq(deletionRequests.entityId, designSessionId),
            inArray(deletionRequests.phase, [
              'requested',
              'draining',
              'runtime_closed',
              'database_deleted',
              'filesystem_cleaned'
            ])
          )
        )
        .limit(1)
        .all()[0]
      if (activeDeletion) return { ok: false as const, reason: 'deleting' as const }

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
      if (!current) return { ok: false as const, reason: 'conflict' as const }

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
        manifest: stagedAssets.manifest
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
          status: 'published',
          phase: 'archived',
          lastError: null,
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

      if (result.changes !== 1) return { ok: false as const, reason: 'conflict' as const }

      db.insert(threads)
        .values({
          id: taskThreadId,
          username,
          projectId: sourceThread.projectId,
          title: current.title,
          status: 'draft',
          conversationId: taskConversationId,
          coreCode: sourceThread.coreCode,
          runtimeStatus: 'idle',
          runtimeSessionId: null,
          coreRuntimeJson: '{}',
          lastError: null,
          lastUsedAt: null,
          titleSource: 'auto',
          activeDraftId: null,
          activePlanId: null,
          wizardPhase: 'collect',
          threadKind: THREAD_KIND_TASK_SNAPSHOT,
          createdAt: confirmedAt,
          updatedAt: confirmedAt
        })
        .run()

      db.insert(threadMessages)
        .values({
          id: taskDraftMessageId,
          threadId: taskThreadId,
          username,
          role: 'assistant',
          kind: 'task-launch-draft',
          content: draftMessage.content,
          coreCode: sourceThread.coreCode,
          conversationId: taskConversationId,
          runtimeSessionId: null,
          payloadJson: taskSnapshotPayloadJson,
          payloadArtifactId: null,
          attachmentsJson: '[]',
          wizardPhase: null,
          createdAt: new Date(confirmedAt * 1000).toISOString()
        })
        .run()

      db.insert(threadJobs)
        .values({
          ...current,
          id: taskJobId,
          threadId: taskThreadId,
          draftMessageId: taskDraftMessageId,
          status: 'pending',
          phase: 'archived',
          workspacePath: currentSnapshot.workspaceRoot,
          planPhase: currentPlanProgress.phase,
          planStatus: currentPlanProgress.status,
          planContextsRegistered: currentPlanProgress.contextsRegistered,
          planContextsTotal: currentPlanProgress.contextsTotal,
          planMessage: currentPlanProgress.message ?? null,
          planCountsJson: JSON.stringify(planCounts),
          taskPhase: 'idle',
          taskStatus: 'pending',
          taskCurrentIndex: 0,
          taskTotal: currentTaskProgress.total,
          taskCurrentTaskId: null,
          taskMessage: null,
          taskMetaJson: '{}',
          draftConfirmedAt: current.draftConfirmedAt ?? confirmedAt,
          planConfirmedAt: confirmedAt,
          designSessionId,
          snapshotDraftRevision: currentSnapshot.draftRevision,
          snapshotPlanRevision: currentSnapshot.planRevision,
          snapshotManifestRevision: currentSnapshot.manifestRevision,
          referenceManifestJson: JSON.stringify(stagedAssets.manifest),
          lastError: null,
          executionLeaseOwner: null,
          executionLeaseExpiresAt: null,
          activeRunId: null,
          planArtifactId: null,
          planArtifactPath: null,
          planSummaryJson: null,
          createdAt: confirmedAt,
          updatedAt: confirmedAt
        })
        .run()

      saveJobPlanInTx(db, taskJobId, currentPlan!)
      for (const [index, ability] of currentAbilities.entries()) {
        db.insert(jobAbilities)
          .values({
            jobId: taskJobId,
            abilityCode: ability.abilityCode,
            sortOrder: index,
            label: ability.label ?? null,
            recommendedCoreCode: ability.recommendedCoreCode ?? null
          })
          .run()
      }

      saveTaskProgressInTx(db, taskJobId, currentTaskProgress, eq(threadJobs.id, taskJobId))

      const taskPlanArtifact = putDesignPlanRevisionInTx(db, {
        jobId: taskJobId,
        planRevision: current.planRevision,
        plan: currentPlan!
      })
      db.update(threadJobs)
        .set({
          planArtifactId: taskPlanArtifact.artifactId,
          planArtifactPath: taskPlanArtifact.contentPath,
          planSummaryJson: taskPlanArtifact.summaryJson
        })
        .where(eq(threadJobs.id, taskJobId))
        .run()

      db.update(threadMessages)
        .set({
          payloadJson: sourceDraftPayloadColumns.payloadJson,
          payloadArtifactId: sourceDraftPayloadColumns.payloadArtifactId
        })
        .where(
          and(
            eq(threadMessages.id, current.draftMessageId),
            eq(threadMessages.threadId, threadId),
            eq(threadMessages.username, username)
          )
        )
        .run()

      db.update(threads)
        .set({ activePlanId: null, wizardPhase: 'collect', updatedAt: confirmedAt })
        .where(and(eq(threads.id, threadId), eq(threads.username, username)))
        .run()

      return {
        ok: true as const,
        taskProgress: currentTaskProgress,
        planProgress: currentPlanProgress
      }
    })
  } catch (error) {
    await stagedAssets.cleanup().catch(() => undefined)
    throw error
  }

  if (!txResult.ok) {
    await stagedAssets.cleanup().catch(() => undefined)
    if (txResult.reason === 'deleting') {
      throw AppError.conflict(
        'Draft deletion is already in progress',
        undefined,
        'draft.deletion_in_progress'
      )
    }
    throw AppError.conflict(
      'Plan changed while it was being confirmed',
      undefined,
      'plan.confirm_conflict'
    )
  }

  const { taskProgress } = txResult

  const jobRows = db.select().from(threadJobs).where(eq(threadJobs.id, taskJobId)).limit(1).all()
  const job = jobRows[0] ? await mapJob(jobRows[0], { includePlan: true }) : null
  if (!job) throw AppError.internal('Failed to launch job', 'turn.unknown')

  emitJobEvent(taskJobId, { event: 'task_progress', data: { taskProgress } })
  emitJobEvent(taskJobId, { event: 'job_snapshot', data: { job } })

  // F2 (§7.1): queue advance happens strictly AFTER commit. If it fails the job
  // stays pending for the reconciler / next startup to pick up — never roll back
  // a committed confirmation.
  if (!options?.skipQueueAdvance) {
    try {
      await advanceWorkloadQueue(username)
    } catch (error) {
      console.warn(
        '[design-session] advance queue after confirm failed; job stays pending',
        taskJobId,
        error
      )
    }
    const latestRows = db
      .select()
      .from(threadJobs)
      .where(eq(threadJobs.id, taskJobId))
      .limit(1)
      .all()
    if (latestRows[0]) {
      return mapJob(latestRows[0], { includePlan: true })
    }
  }
  return job
}

export { isDesignSessionId }
