import type {
  SliceVerificationRecordDto,
  TaskEvidenceDto
} from '../../shared/contracts/evidence.ts'
import { DEFAULT_RETENTION_SETTINGS } from '../../shared/contracts/retention.ts'
import type { RetentionSettings } from '../../shared/contracts/retention.ts'
import { getDb } from '../db'
import { putJobArtifact } from './artifacts'
import { slimEvidenceForState, slimSliceVerdict } from './lifecycle-helpers'

export async function storeTaskEvidenceArtifact(input: {
  jobId: string
  taskId: string
  evidence: TaskEvidenceDto
  dataDir: string
  settings?: RetentionSettings | undefined
  db?: ReturnType<typeof getDb> | undefined
  expiresAt?: number | null | undefined
  replaceExisting?: boolean | undefined
}): Promise<{ artifactId: string; slim: TaskEvidenceDto }> {
  const settings = input.settings ?? DEFAULT_RETENTION_SETTINGS
  const db = input.db ?? getDb()

  const artifactId = await putJobArtifact({
    db,
    dataDir: input.dataDir,
    jobId: input.jobId,
    taskId: input.taskId,
    kind: 'task_evidence',
    payload: input.evidence,
    expiresAt: input.expiresAt ?? null,
    settings,
    replaceExisting: input.replaceExisting
  })

  return { artifactId, slim: slimEvidenceForState(input.evidence) }
}

export async function storeSliceVerdictArtifact(input: {
  jobId: string
  sliceId: string
  verdict: SliceVerificationRecordDto
  dataDir: string
  settings?: RetentionSettings | undefined
  db?: ReturnType<typeof getDb> | undefined
  expiresAt?: number | null | undefined
  replaceExisting?: boolean | undefined
}): Promise<{ artifactId: string; slim: SliceVerificationRecordDto }> {
  const artifactId = await putJobArtifact({
    db: input.db ?? getDb(),
    dataDir: input.dataDir,
    jobId: input.jobId,
    taskId: input.sliceId,
    kind: 'slice_verdict',
    payload: input.verdict,
    expiresAt: input.expiresAt ?? null,
    settings: input.settings ?? DEFAULT_RETENTION_SETTINGS,
    replaceExisting: input.replaceExisting
  })

  return { artifactId, slim: slimSliceVerdict(input.verdict) }
}
