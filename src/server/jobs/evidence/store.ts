import { readFileSync } from 'fs'
import { gunzipSync } from 'zlib'
import { join } from 'path'
import type { SliceVerificationRecordDto, TaskEvidenceDto } from '@shared/contracts/evidence'
import type { TaskProgressDto, TaskProgressItemDto, TaskProgressSliceDto } from '../types'
import type { JobArtifactKind, RetentionSettings } from '@shared/contracts/retention'
import {
  deleteJobArtifact,
  getJobArtifactPayload,
  isLegacyEvidenceRef,
  readLegacyEvidenceFile
} from '../../retention/artifacts'
import {
  storeSliceVerdictArtifact,
  storeTaskEvidenceArtifact
} from '../../retention/evidence-store'
import { getDb, type AppDatabase } from '../../db'
import { jobArtifacts } from '../../db/schema'
import { eq } from 'drizzle-orm'

export const EVIDENCE_INLINE_MAX_BYTES = 2048

export type ExternalizeArtifactOptions = {
  expiresAt?: number | null
  replaceExisting?: boolean
}

export type ExternalizedEvidenceArtifact = {
  artifactId: string
  taskId: string
  kind: Extract<JobArtifactKind, 'task_evidence' | 'slice_verdict'>
}

export type ExternalizedTaskProgressEvidence = {
  progress: TaskProgressDto
  artifacts: ExternalizedEvidenceArtifact[]
  artifactIds: string[]
}

export function isExternalizedEvidence(
  evidence: TaskEvidenceDto | null | undefined
): evidence is TaskEvidenceDto & { evidenceRef: string } {
  return Boolean(evidence?.evidenceRef?.trim())
}

export function slimTaskEvidence(evidence: TaskEvidenceDto): TaskEvidenceDto {
  if (!evidence.evidence?.length) return evidence
  return {
    ...evidence,
    evidence: [],
    evidenceLineCount: evidence.evidenceLineCount ?? evidence.evidence.length
  }
}

export async function externalizeTaskEvidence(
  dataDir: string,
  jobId: string,
  taskId: string,
  evidence: TaskEvidenceDto,
  settings?: RetentionSettings,
  db?: ReturnType<typeof getDb>,
  options?: ExternalizeArtifactOptions
): Promise<{ evidence: TaskEvidenceDto; artifactId: string }> {
  const stored = await storeTaskEvidenceArtifact({
    jobId,
    taskId,
    evidence,
    dataDir,
    settings,
    db,
    expiresAt: options?.expiresAt,
    replaceExisting: options?.replaceExisting
  })
  return { evidence: stored.slim, artifactId: stored.artifactId }
}

export async function hydrateTaskEvidence(
  dataDir: string,
  evidence: TaskEvidenceDto | null | undefined,
  artifactId?: string | null
): Promise<TaskEvidenceDto | null> {
  if (!evidence && !artifactId) return null

  if (artifactId) {
    const full = await getJobArtifactPayload<TaskEvidenceDto>(getDb(), dataDir, artifactId)
    if (full) {
      return { ...full, evidenceLineCount: full.evidence?.length ?? evidence?.evidenceLineCount }
    }
  }

  if (!evidence) return null

  if (evidence.evidenceRef?.trim()) {
    if (isLegacyEvidenceRef(evidence.evidenceRef)) {
      const legacy = await readLegacyEvidenceFile(dataDir, evidence.evidenceRef)
      if (legacy && typeof legacy === 'object') {
        return {
          ...(legacy as TaskEvidenceDto),
          evidenceRef: evidence.evidenceRef,
          evidenceLineCount:
            evidence.evidenceLineCount ?? (legacy as TaskEvidenceDto).evidence?.length
        }
      }
    }
  }

  if (evidence.evidence?.length) return evidence
  return evidence
}

async function externalizeSliceProgress(
  dataDir: string,
  jobId: string,
  slices: TaskProgressSliceDto[] | undefined,
  settings?: RetentionSettings,
  options?: ExternalizeArtifactOptions
): Promise<{
  slices: TaskProgressSliceDto[] | undefined
  artifacts: ExternalizedEvidenceArtifact[]
}> {
  if (!slices?.length) return { slices, artifacts: [] }
  const next: TaskProgressSliceDto[] = []
  const artifacts: ExternalizedEvidenceArtifact[] = []
  for (const slice of slices) {
    if (!slice.verdict) {
      next.push(slice)
      continue
    }
    const stored = await storeSliceVerdictArtifact({
      jobId,
      sliceId: slice.id,
      verdict: slice.verdict,
      dataDir,
      settings,
      expiresAt: options?.expiresAt,
      replaceExisting: options?.replaceExisting
    })
    artifacts.push({ artifactId: stored.artifactId, taskId: slice.id, kind: 'slice_verdict' })
    next.push({
      ...slice,
      verdict: stored.slim,
      verdictArtifactId: stored.artifactId,
      verdictSummary: stored.slim.summary
    })
  }
  return { slices: next, artifacts }
}

async function hydrateSliceProgress(
  dataDir: string,
  slices: TaskProgressSliceDto[] | undefined
): Promise<TaskProgressSliceDto[] | undefined> {
  if (!slices?.length) return slices
  const db = getDb()
  const next: TaskProgressSliceDto[] = []
  for (const slice of slices) {
    if (!slice.verdictArtifactId) {
      next.push(slice)
      continue
    }
    const full = await getJobArtifactPayload<SliceVerificationRecordDto>(
      db,
      dataDir,
      slice.verdictArtifactId
    )
    next.push(full ? { ...slice, verdict: full } : slice)
  }
  return next
}

export async function externalizeTaskProgressEvidence(
  dataDir: string,
  jobId: string,
  progress: TaskProgressDto,
  settings?: RetentionSettings
): Promise<TaskProgressDto> {
  return (await externalizeTaskProgressEvidenceForCommit(dataDir, jobId, progress, settings))
    .progress
}

export async function externalizeTaskProgressEvidenceForCommit(
  dataDir: string,
  jobId: string,
  progress: TaskProgressDto,
  settings?: RetentionSettings,
  options?: ExternalizeArtifactOptions
): Promise<ExternalizedTaskProgressEvidence> {
  const tasks = await Promise.all(
    progress.tasks.map(
      async (
        task
      ): Promise<{ task: TaskProgressItemDto; artifact: ExternalizedEvidenceArtifact | null }> => {
        if (!task.evidence) return { task, artifact: null }
        const stored = await externalizeTaskEvidence(
          dataDir,
          jobId,
          task.id,
          task.evidence,
          settings,
          undefined,
          options
        )
        return {
          task: {
            ...task,
            evidence: stored.evidence,
            evidenceArtifactId: stored.artifactId,
            evidenceSummary: stored.evidence.summary,
            blockerKind: stored.evidence.blockerKind ?? task.blockerKind,
            recoveryAction: stored.evidence.recovery?.action ?? task.recoveryAction
          },
          artifact: {
            artifactId: stored.artifactId,
            taskId: task.id,
            kind: 'task_evidence' as const
          }
        }
      }
    )
  )
  const slices = await externalizeSliceProgress(dataDir, jobId, progress.slices, settings, options)
  const artifacts: ExternalizedEvidenceArtifact[] = [
    ...tasks
      .map((entry) => entry.artifact)
      .filter((artifact): artifact is ExternalizedEvidenceArtifact => Boolean(artifact)),
    ...slices.artifacts
  ]
  return {
    progress: {
      ...progress,
      tasks: tasks.map((entry) => entry.task),
      slices: slices.slices
    },
    artifacts,
    artifactIds: artifacts.map((artifact) => artifact.artifactId)
  }
}

export async function deleteTaskProgressEvidenceArtifacts(
  dataDir: string,
  artifactIds: string[],
  db: AppDatabase = getDb()
): Promise<void> {
  for (const artifactId of new Set(artifactIds)) {
    await deleteJobArtifact({ db, dataDir, artifactId })
  }
}

export async function deleteSupersededTaskProgressEvidenceArtifacts(
  dataDir: string,
  jobId: string,
  artifacts: ExternalizedEvidenceArtifact[],
  db: AppDatabase = getDb()
): Promise<void> {
  if (artifacts.length === 0) return
  const keepIds = new Set(artifacts.map((artifact) => artifact.artifactId))
  const replacedKeys = new Set(
    artifacts.map((artifact) => `${artifact.kind}\u0000${artifact.taskId}`)
  )
  const rows = await db.select().from(jobArtifacts).where(eq(jobArtifacts.jobId, jobId))
  const supersededIds = rows
    .filter((row) => {
      if (!row.taskId || keepIds.has(row.id)) return false
      return replacedKeys.has(`${row.kind}\u0000${row.taskId}`)
    })
    .map((row) => row.id)
  await deleteTaskProgressEvidenceArtifacts(dataDir, supersededIds, db)
}

export async function hydrateTaskProgressEvidence(
  dataDir: string,
  progress: TaskProgressDto,
  options?: { hydrateEvidence?: boolean }
): Promise<TaskProgressDto> {
  if (options?.hydrateEvidence === false) return progress
  const tasks = await Promise.all(
    progress.tasks.map(async (task) => {
      const evidence = await hydrateTaskEvidence(dataDir, task.evidence, task.evidenceArtifactId)
      return evidence ? { ...task, evidence } : task
    })
  )
  const slices = await hydrateSliceProgress(dataDir, progress.slices)
  return { ...progress, tasks, slices }
}

export function slimTaskProgressItemsForRuntime(
  items: TaskProgressItemDto[]
): TaskProgressItemDto[] {
  return items.map((item) =>
    item.evidence ? { ...item, evidence: slimTaskEvidence(item.evidence) } : item
  )
}

export async function getTaskEvidenceDetail(input: {
  dataDir: string
  artifactId: string
}): Promise<TaskEvidenceDto | null> {
  return getJobArtifactPayload<TaskEvidenceDto>(getDb(), input.dataDir, input.artifactId)
}

export function hydrateTaskEvidenceSync(
  dataDir: string,
  evidence: TaskEvidenceDto | null | undefined,
  artifactId?: string | null,
  db: AppDatabase = getDb()
): TaskEvidenceDto | null {
  if (artifactId) {
    const rows = db
      .select()
      .from(jobArtifacts)
      .where(eq(jobArtifacts.id, artifactId))
      .limit(1)
      .all()
    const row = rows[0]
    if (row?.storage === 'inline' && row.contentInline) {
      try {
        return JSON.parse(row.contentInline) as TaskEvidenceDto
      } catch {
        return evidence ?? null
      }
    }
    if (row?.storage === 'file' && row.contentPath) {
      const rel = row.contentPath.replace(/\\/g, '/').replace(/^\/+/, '')
      if (!rel.includes('..')) {
        try {
          const buf = readFileSync(join(dataDir, rel))
          return JSON.parse(gunzipSync(buf).toString('utf8')) as TaskEvidenceDto
        } catch {
          return evidence ?? null
        }
      }
    }
  }

  if (!evidence) return null
  if (evidence.evidenceRef?.trim() && isLegacyEvidenceRef(evidence.evidenceRef)) {
    const rel = evidence.evidenceRef.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!rel.includes('..')) {
      try {
        const raw = readFileSync(join(dataDir, rel), 'utf8')
        const full = JSON.parse(raw) as TaskEvidenceDto
        return {
          ...full,
          evidenceRef: evidence.evidenceRef,
          evidenceLineCount: evidence.evidenceLineCount ?? full.evidence?.length
        }
      } catch {
        return evidence
      }
    }
  }
  if (evidence.evidence?.length) return evidence
  return evidence
}
