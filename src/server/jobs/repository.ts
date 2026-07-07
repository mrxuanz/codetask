import { and, asc, eq, gt, inArray, isNull, lt, or, type SQL } from 'drizzle-orm'
import { isDesignSessionId } from '@shared/design-session'
import { parseJobReferenceManifest, toPublicReferenceManifest } from '@shared/job-references'
import { enrichJobWithRecoveryState } from '@shared/job-recovery-state'
import { hydrateTurnErrorField, coercePersistedTurnError } from '../turn-errors/store'
import type { TurnErrorDto } from '../../shared/turn-errors.ts'
import { getDb } from '../db'
import { loadTaskProgress, saveTaskProgress, saveTaskProgressInTx } from '../db/job-progress'
import {
  loadJobAbilities,
  loadJobPlan,
  loadPlanProgress,
  saveJobPlan,
  saveJobPlanInTx,
  savePlanProgress
} from '../db/job-plan'
import { jobArtifacts, threadJobs, type ThreadJob } from '../db/schema'
import type { PlanProgressDto, TaskProgressDto, ThreadJobDto } from './types'
import type { SavedJobPlan } from '../planner/plan-types'
import { getAppContext } from '../bootstrap'
import { onJobStatusTransition } from '../retention'
import { readRetentionSettings } from '../retention/settings'
import {
  deleteSupersededTaskProgressEvidenceArtifacts,
  deleteTaskProgressEvidenceArtifacts,
  externalizeTaskProgressEvidenceForCommit,
  type ExternalizedEvidenceArtifact
} from './evidence/store'
import { slimTaskProgressForSse } from './progress-sse'

export const EXECUTION_OCCUPYING_STATUSES = ['running'] as const
export const EXECUTION_LEASE_TTL_SEC = 30 * 60
const TENTATIVE_EVIDENCE_ARTIFACT_TTL_SEC = 24 * 60 * 60

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function executionLeaseOwner(): string {
  return `pid-${process.pid}`
}

import {
  anyRunningJobClause,
  findInMemoryExecutionOccupant,
  findWorkloadOccupant,
  isWorkloadBlockedInMemory
} from './workload-slot'

function resumableForLeaseClause(now: number): SQL {
  return or(
    eq(threadJobs.status, 'pending'),
    eq(threadJobs.status, 'paused'),
    eq(threadJobs.status, 'failed'),
    eq(threadJobs.status, 'cancelled'),
    and(
      eq(threadJobs.status, 'running'),
      or(
        isNull(threadJobs.executionLeaseOwner),
        isNull(threadJobs.executionLeaseExpiresAt),
        lt(threadJobs.executionLeaseExpiresAt, now)
      )
    )
  )!
}

export async function findOccupyingJobId(
  username: string,
  exceptJobId?: string
): Promise<string | null> {
  return findWorkloadOccupant(username, exceptJobId)
}

export async function findNextPendingJobId(username: string): Promise<string | null> {
  const db = getDb()
  const rows = await db
    .select({ id: threadJobs.id })
    .from(threadJobs)
    .where(and(eq(threadJobs.username, username), eq(threadJobs.status, 'pending')))
    .orderBy(asc(threadJobs.createdAt))
    .limit(1)
  return rows[0]?.id ?? null
}

export async function findRestartInterruptedPausedJobId(username: string): Promise<string | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(and(eq(threadJobs.username, username), eq(threadJobs.status, 'paused')))
    .orderBy(asc(threadJobs.updatedAt))

  for (const row of rows) {
    const job = await mapJob(row, { includePlan: true })
    const { isRestartInterruptedPause } = await import('./execution-recovery')
    if (isRestartInterruptedPause(job)) return job.id
  }
  return null
}

export function tryPromoteJobToRunning(username: string, jobId: string): boolean {
  const db = getDb()
  const now = nowSec()
  const owner = executionLeaseOwner()

  if (isWorkloadBlockedInMemory(username, jobId)) return false

  return db.transaction((tx) => {
    const occupying = tx
      .select({ id: threadJobs.id })
      .from(threadJobs)
      .where(anyRunningJobClause(username))
      .limit(1)
      .all()

    const occupierId = occupying[0]?.id
    if (occupierId && occupierId !== jobId) {
      return false
    }

    const updated = tx
      .update(threadJobs)
      .set({
        status: 'running',
        executionLeaseOwner: owner,
        executionLeaseExpiresAt: now + EXECUTION_LEASE_TTL_SEC,
        lastError: null,
        updatedAt: now
      })
      .where(
        and(
          eq(threadJobs.id, jobId),
          eq(threadJobs.username, username),
          eq(threadJobs.status, 'pending')
        )
      )
      .run()

    if (!updated.changes) {
      return false
    }

    const rows = tx
      .select({
        status: threadJobs.status,
        executionLeaseOwner: threadJobs.executionLeaseOwner
      })
      .from(threadJobs)
      .where(eq(threadJobs.id, jobId))
      .limit(1)
      .all()

    const row = rows[0]
    return row?.status === 'running' && row.executionLeaseOwner === owner
  })
}

export function hasLocalExecutionLease(username: string, jobId: string): boolean {
  const db = getDb()
  const now = nowSec()
  const owner = executionLeaseOwner()
  const rows = db
    .select({ id: threadJobs.id })
    .from(threadJobs)
    .where(
      and(
        eq(threadJobs.id, jobId),
        eq(threadJobs.username, username),
        eq(threadJobs.status, 'running'),
        eq(threadJobs.executionLeaseOwner, owner),
        or(isNull(threadJobs.executionLeaseExpiresAt), gt(threadJobs.executionLeaseExpiresAt, now))
      )
    )
    .limit(1)
    .all()
  return rows.length > 0
}

export function acquireExecutionLease(username: string, jobId: string): boolean {
  if (hasLocalExecutionLease(username, jobId)) {
    const now = nowSec()
    getDb()
      .update(threadJobs)
      .set({
        executionLeaseOwner: executionLeaseOwner(),
        executionLeaseExpiresAt: now + EXECUTION_LEASE_TTL_SEC,
        updatedAt: now
      })
      .where(and(eq(threadJobs.id, jobId), eq(threadJobs.status, 'running')))
      .run()
    return true
  }

  const db = getDb()
  const now = nowSec()
  const owner = executionLeaseOwner()

  const inMemoryOccupier = findInMemoryExecutionOccupant(username, jobId)
  if (inMemoryOccupier) return false
  if (isWorkloadBlockedInMemory(username, jobId)) return false

  return db.transaction((tx) => {
    const occupying = tx
      .select({ id: threadJobs.id })
      .from(threadJobs)
      .where(anyRunningJobClause(username))
      .limit(1)
      .all()

    const occupierId = occupying[0]?.id
    if (occupierId && occupierId !== jobId) {
      return false
    }

    const updated = tx
      .update(threadJobs)
      .set({
        status: 'running',
        executionLeaseOwner: owner,
        executionLeaseExpiresAt: now + EXECUTION_LEASE_TTL_SEC,
        lastError: null,
        updatedAt: now
      })
      .where(
        and(
          eq(threadJobs.id, jobId),
          eq(threadJobs.username, username),
          resumableForLeaseClause(now)
        )
      )
      .run()

    if (!updated.changes) {
      return false
    }

    const rows = tx
      .select({
        status: threadJobs.status,
        executionLeaseOwner: threadJobs.executionLeaseOwner
      })
      .from(threadJobs)
      .where(eq(threadJobs.id, jobId))
      .limit(1)
      .all()

    const row = rows[0]
    return row?.status === 'running' && row.executionLeaseOwner === owner
  })
}

export function refreshExecutionLease(jobId: string): void {
  const now = nowSec()
  getDb()
    .update(threadJobs)
    .set({
      executionLeaseOwner: executionLeaseOwner(),
      executionLeaseExpiresAt: now + EXECUTION_LEASE_TTL_SEC,
      updatedAt: now
    })
    .where(and(eq(threadJobs.id, jobId), eq(threadJobs.status, 'running')))
    .run()
}

export async function clearExecutionLease(jobId: string): Promise<void> {
  await getDb()
    .update(threadJobs)
    .set({
      executionLeaseOwner: null,
      executionLeaseExpiresAt: null,
      updatedAt: nowSec()
    })
    .where(eq(threadJobs.id, jobId))
}

export async function mapJob(
  row: ThreadJob,
  options?: { includePlan?: boolean; hydrateEvidence?: boolean }
): Promise<ThreadJobDto> {
  const db = getDb()
  const includePlan = options?.includePlan ?? false
  const hydrateEvidence = options?.hydrateEvidence ?? false
  const [abilities, planProgress, plan] = await Promise.all([
    loadJobAbilities(db, row.id),
    loadPlanProgress(db, row.id),
    includePlan ? loadJobPlan(db, row.id) : Promise.resolve(null)
  ])
  let taskProgress = await loadTaskProgress(db, row.id, {
    planTasks: plan?.tasks ?? [],
    hydrateEvidence,
    dataDir: getAppContext().dataDir
  })
  if (!hydrateEvidence) {
    taskProgress = slimTaskProgressForSse(taskProgress)
  }
  const manifest = parseJobReferenceManifest(row.referenceManifestJson)
  return enrichJobWithRecoveryState({
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
    workspacePath: row.workspacePath,
    lastError: hydrateTurnErrorField(row.lastError),
    draftConfirmedAt: row.draftConfirmedAt ?? null,
    planConfirmedAt: row.planConfirmedAt ?? null,
    designSessionId: row.designSessionId ?? null,
    snapshotDraftRevision: row.snapshotDraftRevision ?? null,
    snapshotPlanRevision: row.snapshotPlanRevision ?? null,
    snapshotManifestRevision: row.snapshotManifestRevision ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  })
}

export async function getUserJob(username: string, jobId: string): Promise<ThreadJobDto | null> {
  if (isDesignSessionId(jobId)) {
    const { getUserDesignSessionAsJob } = await import('../design-session/service')
    return getUserDesignSessionAsJob(username, jobId)
  }
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(and(eq(threadJobs.id, jobId), eq(threadJobs.username, username)))
    .limit(1)
  return rows[0] ? await mapJob(rows[0], { includePlan: true }) : null
}

export async function getThreadJob(
  username: string,
  threadId: string,
  jobId: string
): Promise<ThreadJobDto | null> {
  if (isDesignSessionId(jobId)) {
    const { getDesignSessionAsJob } = await import('../design-session/service')
    return getDesignSessionAsJob(username, threadId, jobId)
  }
  const db = getDb()
  const rows = await db
    .select()
    .from(threadJobs)
    .where(
      and(
        eq(threadJobs.id, jobId),
        eq(threadJobs.threadId, threadId),
        eq(threadJobs.username, username)
      )
    )
    .limit(1)
  return rows[0] ? await mapJob(rows[0], { includePlan: true }) : null
}

export type JobRowPatch = Partial<{
  status: string
  plan: SavedJobPlan | null
  planProgress: PlanProgressDto
  taskProgress: TaskProgressDto
  lastError: TurnErrorDto | string | null
  draftConfirmedAt: number | null
  planConfirmedAt: number | null
}>

export async function updateJobRow(
  jobId: string,
  patch: JobRowPatch,
  options?: { includePlan?: boolean; hydrateEvidence?: boolean }
): Promise<ThreadJobDto | null> {
  const db = getDb()
  const existingRows = await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1)
  const previousStatus = existingRows[0]?.status
  const threadId = existingRows[0]?.threadId

  const { taskProgress, plan, planProgress, ...rowPatch } = patch
  const now = nowSec()
  const leaseClear =
    rowPatch.status && rowPatch.status !== 'running'
      ? { executionLeaseOwner: null, executionLeaseExpiresAt: null }
      : {}

  const { lastError, ...restRowPatch } = rowPatch
  const dbPatch = {
    ...restRowPatch,
    ...(lastError !== undefined ? { lastError: coercePersistedTurnError(lastError) } : {})
  }

  if (Object.keys(dbPatch).length > 0) {
    await db
      .update(threadJobs)
      .set({ ...dbPatch, ...leaseClear, updatedAt: now })
      .where(eq(threadJobs.id, jobId))
  }

  if (plan !== undefined) {
    await saveJobPlan(db, jobId, plan)
    await db.update(threadJobs).set({ updatedAt: now }).where(eq(threadJobs.id, jobId))
  }

  if (planProgress) {
    await savePlanProgress(db, jobId, planProgress)
    await db.update(threadJobs).set({ updatedAt: now }).where(eq(threadJobs.id, jobId))
  }

  if (taskProgress) {
    await saveTaskProgress(db, jobId, taskProgress)
    await db.update(threadJobs).set({ updatedAt: now }).where(eq(threadJobs.id, jobId))
  }

  if (rowPatch.status && previousStatus && threadId && rowPatch.status !== previousStatus) {
    await onJobStatusTransition({
      jobId,
      threadId,
      previousStatus,
      nextStatus: rowPatch.status
    })
  }

  const rows = await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1)
  return rows[0]
    ? await mapJob(rows[0], {
        includePlan: options?.includePlan ?? false,
        hydrateEvidence: options?.hydrateEvidence ?? false
      })
    : null
}

export async function updateJobRowForSnapshot(
  jobId: string,
  patch: JobRowPatch
): Promise<ThreadJobDto | null> {
  return updateJobRow(jobId, patch, { includePlan: true, hydrateEvidence: false })
}

function jobRowFence(jobId: string, runId: string): SQL {
  return and(eq(threadJobs.id, jobId), eq(threadJobs.activeRunId, runId))!
}

type FencedJobPatchTxResult =
  | { ok: false }
  | { ok: true; previousStatus: string; threadId: string }

function applyPlanProgressInTx(
  tx: ReturnType<typeof getDb>,
  jobId: string,
  runId: string,
  progress: PlanProgressDto
): void {
  const counts = {
    milestones: progress.milestones,
    slices: progress.slices,
    tasks: progress.tasks
  }
  tx.update(threadJobs)
    .set({
      planPhase: progress.phase,
      planStatus: progress.status,
      planContextsRegistered: progress.contextsRegistered,
      planContextsTotal: progress.contextsTotal,
      planMessage: progress.message ?? null,
      planCountsJson: JSON.stringify(counts)
    })
    .where(jobRowFence(jobId, runId))
    .run()
}

function applyFencedJobPatchInTx(
  tx: ReturnType<typeof getDb>,
  jobId: string,
  runId: string,
  patch: JobRowPatch,
  storedTaskProgress?: TaskProgressDto,
  artifactIdsToRetain: string[] = []
): FencedJobPatchTxResult {
  const fence = jobRowFence(jobId, runId)
  const existing = tx.select().from(threadJobs).where(fence).limit(1).all()[0]
  if (!existing) return { ok: false }

  const now = nowSec()
  const { taskProgress, plan, planProgress, ...rowPatch } = patch
  const progressToStore = storedTaskProgress ?? taskProgress
  const leaseClear =
    rowPatch.status && rowPatch.status !== 'running'
      ? { executionLeaseOwner: null, executionLeaseExpiresAt: null }
      : {}

  const { lastError, ...restRowPatch } = rowPatch
  const dbPatch = {
    ...restRowPatch,
    ...(lastError !== undefined ? { lastError: coercePersistedTurnError(lastError) } : {})
  }

  if (Object.keys(dbPatch).length > 0) {
    const result = tx
      .update(threadJobs)
      .set({ ...dbPatch, ...leaseClear, updatedAt: now })
      .where(fence)
      .run()
    if (result.changes === 0) return { ok: false }
  }

  if (plan !== undefined) {
    saveJobPlanInTx(tx, jobId, plan)
    tx.update(threadJobs).set({ updatedAt: now }).where(fence).run()
  }

  if (planProgress) {
    applyPlanProgressInTx(tx, jobId, runId, planProgress)
    tx.update(threadJobs).set({ updatedAt: now }).where(fence).run()
  }

  if (progressToStore) {
    saveTaskProgressInTx(tx, jobId, progressToStore, fence)
    if (artifactIdsToRetain.length > 0) {
      tx.update(jobArtifacts)
        .set({ expiresAt: null })
        .where(inArray(jobArtifacts.id, artifactIdsToRetain))
        .run()
    }
    tx.update(threadJobs).set({ updatedAt: now }).where(fence).run()
  }

  const stillFenced = tx.select().from(threadJobs).where(fence).limit(1).all()[0]
  if (!stillFenced) return { ok: false }

  return { ok: true, previousStatus: existing.status, threadId: existing.threadId }
}

async function cleanupUncommittedEvidenceArtifacts(
  dataDir: string | undefined,
  artifactIds: string[]
): Promise<void> {
  if (!dataDir || artifactIds.length === 0) return
  await deleteTaskProgressEvidenceArtifacts(dataDir, artifactIds).catch((error) => {
    console.warn('[jobs] failed to cleanup uncommitted evidence artifacts', { artifactIds, error })
  })
}

async function cleanupSupersededEvidenceArtifacts(
  dataDir: string | undefined,
  jobId: string,
  artifacts: ExternalizedEvidenceArtifact[]
): Promise<void> {
  if (!dataDir || artifacts.length === 0) return
  await deleteSupersededTaskProgressEvidenceArtifacts(dataDir, jobId, artifacts).catch((error) => {
    console.warn('[jobs] failed to cleanup superseded evidence artifacts', {
      artifactIds: artifacts.map((artifact) => artifact.artifactId),
      error
    })
  })
}

export async function updateJobRowFenced(
  jobId: string,
  runId: string,
  patch: JobRowPatch,
  options?: { includePlan?: boolean; hydrateEvidence?: boolean }
): Promise<ThreadJobDto | null> {
  const db = getDb()
  let storedTaskProgress: TaskProgressDto | undefined
  let taskProgressDataDir: string | undefined
  let createdArtifacts: ExternalizedEvidenceArtifact[] = []
  let createdArtifactIds: string[] = []
  if (patch.taskProgress) {
    const dataDir = getAppContext().dataDir
    taskProgressDataDir = dataDir
    const settings = readRetentionSettings(getAppContext().settings)
    const externalized = await externalizeTaskProgressEvidenceForCommit(
      dataDir,
      jobId,
      patch.taskProgress,
      settings,
      {
        expiresAt: nowSec() + TENTATIVE_EVIDENCE_ARTIFACT_TTL_SEC,
        replaceExisting: false
      }
    )
    storedTaskProgress = externalized.progress
    createdArtifacts = externalized.artifacts
    createdArtifactIds = externalized.artifactIds
  }

  let txResult: FencedJobPatchTxResult
  try {
    txResult = db.transaction((tx) =>
      applyFencedJobPatchInTx(tx, jobId, runId, patch, storedTaskProgress, createdArtifactIds)
    )
  } catch (error) {
    await cleanupUncommittedEvidenceArtifacts(taskProgressDataDir, createdArtifactIds)
    throw error
  }

  if (!txResult.ok) {
    await cleanupUncommittedEvidenceArtifacts(taskProgressDataDir, createdArtifactIds)
    return null
  }

  await cleanupSupersededEvidenceArtifacts(taskProgressDataDir, jobId, createdArtifacts)

  if (
    patch.status &&
    txResult.previousStatus &&
    patch.status !== txResult.previousStatus
  ) {
    await onJobStatusTransition({
      jobId,
      threadId: txResult.threadId,
      previousStatus: txResult.previousStatus,
      nextStatus: patch.status
    })
  }

  const rows = await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1)
  return rows[0]
    ? await mapJob(rows[0], {
        includePlan: options?.includePlan ?? false,
        hydrateEvidence: options?.hydrateEvidence ?? false
      })
    : null
}

export async function updateJobRowForSnapshotFenced(
  jobId: string,
  runId: string,
  patch: JobRowPatch
): Promise<ThreadJobDto | null> {
  return updateJobRowFenced(jobId, runId, patch, { includePlan: true, hydrateEvidence: false })
}

export async function transitionJobStatus(
  jobId: string,
  fromStatuses: string[],
  patch: JobRowPatch
): Promise<ThreadJobDto | null> {
  const db = getDb()
  const rows = await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1)
  const current = rows[0]
  if (!current || !fromStatuses.includes(current.status)) {
    return null
  }
  return updateJobRow(jobId, patch)
}
