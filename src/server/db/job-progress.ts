import { asc, eq } from 'drizzle-orm'
import type { getDb } from './index'
import type {
  TaskProgressDto,
  TaskProgressItemDto,
  TaskProgressMilestoneDto,
  TaskProgressSliceDto
} from '../jobs/types'
import type { TaskEvidenceDto } from '@shared/contracts/evidence'
import {
  parseStoredTurnError,
  serializeStoredTurnError,
  turnErrorDisplayMessage
} from '../../shared/turn-errors.ts'
import { normalizeTurnErrorFromMessage } from '../../shared/turn-errors.ts'
import { defaultTaskProgress } from '../planner/save-plan'
import type { SavedJobPlan } from '../planner/plan-types'
import { getAppContext } from '../bootstrap'
import {
  externalizeTaskProgressEvidence,
  hydrateTaskProgressEvidence
} from '../jobs/evidence/store'
import {
  loadJobCountersIntoProgress,
  syncJobCountersFromProgress,
  summarizeEvidence
} from '../retention'
import { readRetentionSettings } from '../retention/settings'
import { jobTasks, threadJobs } from './schema'

type TaskMeta = {
  slices?: TaskProgressSliceDto[]
  milestones?: TaskProgressMilestoneDto[]

  repairGenerations?: Record<string, number>
  verificationAttempts?: Record<string, number>
  verificationBundleHashes?: Record<string, string>
}

type AppDatabase = ReturnType<typeof getDb>

function parseMeta(value: string | null | undefined): TaskMeta {
  if (!value) return {}
  try {
    return JSON.parse(value) as TaskMeta
  } catch {
    return {}
  }
}

function parseEvidenceJson(value: string | null | undefined): TaskEvidenceDto | null {
  if (!value) return null
  try {
    return JSON.parse(value) as TaskEvidenceDto
  } catch {
    return null
  }
}

function mapTaskRow(row: typeof jobTasks.$inferSelect): TaskProgressItemDto {
  const error = parseStoredTurnError(row.errorMessage)
  const evidence = parseEvidenceJson(row.evidenceJson)
  return {
    id: row.taskId,
    title: row.title,
    status: row.status as TaskProgressItemDto['status'],
    abilityCode: row.abilityCode ?? undefined,
    executionStatus: row.executionStatus,
    evidenceStatus: row.evidenceStatus,
    evidence,
    evidenceArtifactId: row.evidenceArtifactId,
    evidenceSummary: row.evidenceSummary ?? evidence?.summary ?? null,
    blockerKind:
      (row.blockerKind as TaskProgressItemDto['blockerKind']) ?? evidence?.blockerKind ?? null,
    recoveryAction:
      (row.recoveryAction as TaskProgressItemDto['recoveryAction']) ??
      evidence?.recovery?.action ??
      null,
    error,
    errorMessage: turnErrorDisplayMessage(error) ?? row.errorMessage,
    coreCode: row.coreCode
  }
}

function resolveStoredTaskError(task: TaskProgressItemDto): string | null {
  if (task.error) return serializeStoredTurnError(task.error)
  if (task.errorMessage?.trim()) {
    const parsed = parseStoredTurnError(task.errorMessage)
    if (parsed) return serializeStoredTurnError(parsed)
    return serializeStoredTurnError(normalizeTurnErrorFromMessage(task.errorMessage))
  }
  return null
}

function metaForStorage(progress: TaskProgressDto): TaskMeta {
  return {
    slices: progress.slices,
    milestones: progress.milestones,
    verificationBundleHashes: progress.verificationBundleHashes
  }
}

export async function loadTaskProgress(
  db: AppDatabase,
  jobId: string,
  options?: {
    planTasks?: SavedJobPlan['tasks']
    row?: typeof threadJobs.$inferSelect
    hydrateEvidence?: boolean
    dataDir?: string
  }
): Promise<TaskProgressDto> {
  const row =
    options?.row ?? (await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1))[0]

  if (!row) return defaultTaskProgress(options?.planTasks)

  const taskRows = await db
    .select()
    .from(jobTasks)
    .where(eq(jobTasks.jobId, jobId))
    .orderBy(asc(jobTasks.sortOrder))

  if (taskRows.length === 0) {
    return defaultTaskProgress(options?.planTasks)
  }

  const meta = parseMeta(row.taskMetaJson)
  let base: TaskProgressDto = {
    phase: row.taskPhase as TaskProgressDto['phase'],
    status: row.taskStatus as TaskProgressDto['status'],
    currentIndex: row.taskCurrentIndex,
    total: row.taskTotal,
    currentTaskId: row.taskCurrentTaskId,
    message: row.taskMessage,
    tasks: taskRows.map(mapTaskRow),
    slices: meta.slices,
    milestones: meta.milestones,
    repairGenerations: meta.repairGenerations,
    verificationAttempts: meta.verificationAttempts,
    verificationBundleHashes: meta.verificationBundleHashes
  }

  base = await loadJobCountersIntoProgress(db, jobId, base)

  const hydrate = options?.hydrateEvidence ?? false
  if (!hydrate) return base

  const dataDir = options?.dataDir ?? getAppContext().dataDir
  return hydrateTaskProgressEvidence(dataDir, base, { hydrateEvidence: true })
}

export async function saveTaskProgress(
  db: AppDatabase,
  jobId: string,
  progress: TaskProgressDto,
  options?: { dataDir?: string }
): Promise<void> {
  const dataDir = options?.dataDir ?? getAppContext().dataDir
  const settings = readRetentionSettings(getAppContext().settings)
  const stored = await externalizeTaskProgressEvidence(dataDir, jobId, progress, settings)

  await syncJobCountersFromProgress(db, jobId, stored)

  const meta: TaskMeta = metaForStorage(stored)

  await db
    .update(threadJobs)
    .set({
      taskPhase: stored.phase,
      taskStatus: stored.status,
      taskCurrentIndex: stored.currentIndex,
      taskTotal: stored.total,
      taskCurrentTaskId: stored.currentTaskId ?? null,
      taskMessage: stored.message ?? null,
      taskMetaJson: JSON.stringify(meta)
    })
    .where(eq(threadJobs.id, jobId))

  await db.delete(jobTasks).where(eq(jobTasks.jobId, jobId))

  for (const [index, task] of stored.tasks.entries()) {
    const evidence = task.evidence
    await db.insert(jobTasks).values({
      jobId,
      taskId: task.id,
      title: task.title,
      sortOrder: index,
      status: task.status,
      abilityCode: task.abilityCode ?? null,
      executionStatus: task.executionStatus ?? null,
      evidenceStatus: task.evidenceStatus ?? null,
      evidenceJson: evidence ? JSON.stringify(evidence) : null,
      evidenceArtifactId: task.evidenceArtifactId ?? null,
      evidenceSummary: task.evidenceSummary ?? (evidence ? summarizeEvidence(evidence) : null),
      blockerKind: task.blockerKind ?? evidence?.blockerKind ?? null,
      recoveryAction: task.recoveryAction ?? evidence?.recovery?.action ?? null,
      errorMessage: resolveStoredTaskError(task),
      coreCode: task.coreCode ?? null
    })
  }
}
