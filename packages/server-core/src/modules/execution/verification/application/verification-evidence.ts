import type Database from 'better-sqlite3'
import type { SliceVerdict, TaskEvidence } from '@codetask/contracts'
import type { WorkItemRecord } from '../../work/domain/work-item.ts'

type JobVerificationContext = {
  title: string
  summary: string
  requirementsMarkdown: string
  acceptance: unknown[]
  verification: unknown[]
  nfr: unknown[]
  assumptions: unknown[]
}

export type SliceVerificationEvidenceBundle = {
  schemaVersion: 1
  scopeType: 'slice'
  jobId: string
  generation: number
  job: JobVerificationContext
  slice: {
    id: string
    sourceSliceId: string
    title: string
    description: string
    successCriteria: string
  }
  workItems: Array<{
    id: string
    sourceTaskId: string
    parentWorkId: string | null
    kind: string
    title: string
    description: string
    successCriteria: string
    state: string
    lastError: unknown
    latestAttempt: {
      id: string
      attemptNumber: number
      status: string
      error: unknown
      resultHash: string | null
      evidence: TaskEvidence | null
    } | null
  }>
}

export type MilestoneVerificationEvidenceBundle = {
  schemaVersion: 1
  scopeType: 'milestone'
  jobId: string
  generation: number
  job: JobVerificationContext
  milestone: {
    id: string
    sourceMilestoneId: string
    title: string
    description: string
    successCriteria: string
  }
  slices: Array<{
    id: string
    sourceSliceId: string
    title: string
    description: string
    successCriteria: string
    state: string
    verificationState: string
    verdict: SliceVerdict | null
  }>
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readJobContext(db: Database.Database, jobId: string): JobVerificationContext {
  const row = db
    .prepare(
      `SELECT j.title, j.summary, js.draft_snapshot_json AS draftSnapshotJson
       FROM jobs j
       JOIN job_snapshots js ON js.job_id = j.id
       WHERE j.id = ?`
    )
    .get(jobId) as { title: string; summary: string; draftSnapshotJson: string } | undefined
  if (!row) throw new Error(`Verification job not found: ${jobId}`)

  const draft = parseJson<Record<string, unknown>>(row.draftSnapshotJson, {})
  return {
    title: row.title,
    summary: row.summary,
    requirementsMarkdown:
      typeof draft.requirementsMarkdown === 'string' ? draft.requirementsMarkdown : '',
    acceptance: asArray(draft.acceptance),
    verification: asArray(draft.verification),
    nfr: asArray(draft.nfr),
    assumptions: asArray(draft.assumptions)
  }
}

function readLatestWorkAttempt(
  db: Database.Database,
  jobId: string,
  workId: string
): SliceVerificationEvidenceBundle['workItems'][number]['latestAttempt'] {
  const row = db
    .prepare(
      `SELECT wa.id, wa.attempt_number AS attemptNumber, wa.status,
              wa.error_json AS errorJson, wr.result_hash AS resultHash,
              wr.evidence_json AS evidenceJson
       FROM work_attempts wa
       LEFT JOIN work_results wr ON wr.attempt_id = wa.id
       WHERE wa.job_id = ? AND wa.work_id = ?
       ORDER BY wa.attempt_number DESC
       LIMIT 1`
    )
    .get(jobId, workId) as
    | {
        id: string
        attemptNumber: number
        status: string
        errorJson: string | null
        resultHash: string | null
        evidenceJson: string | null
      }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    attemptNumber: row.attemptNumber,
    status: row.status,
    error: parseJson<unknown>(row.errorJson, null),
    resultHash: row.resultHash,
    evidence: parseJson<TaskEvidence | null>(row.evidenceJson, null)
  }
}

export function buildSliceVerificationEvidence(input: {
  db: Database.Database
  jobId: string
  generation: number
  sliceId: string
  workItems: WorkItemRecord[]
}): SliceVerificationEvidenceBundle {
  const slice = input.db
    .prepare(
      `SELECT id, source_slice_id AS sourceSliceId, title, description,
              success_criteria AS successCriteria
       FROM job_slices
       WHERE job_id = ? AND generation = ? AND id = ?`
    )
    .get(input.jobId, input.generation, input.sliceId) as
    | {
        id: string
        sourceSliceId: string
        title: string
        description: string
        successCriteria: string
      }
    | undefined
  if (!slice) throw new Error(`Verification slice not found: ${input.sliceId}`)

  return {
    schemaVersion: 1,
    scopeType: 'slice',
    jobId: input.jobId,
    generation: input.generation,
    job: readJobContext(input.db, input.jobId),
    slice,
    workItems: input.workItems
      .filter((work) => work.sliceId === input.sliceId)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
      .map((work) => ({
        id: work.id,
        sourceTaskId: work.sourceTaskId,
        parentWorkId: work.parentWorkId,
        kind: work.kind,
        title: work.title,
        description: work.description,
        successCriteria: work.successCriteria,
        state: work.state,
        lastError: parseJson<unknown>(work.lastErrorJson, null),
        latestAttempt: readLatestWorkAttempt(input.db, input.jobId, work.id)
      }))
  }
}

function readLatestSliceVerdict(
  db: Database.Database,
  jobId: string,
  generation: number,
  sliceId: string
): SliceVerdict | null {
  const row = db
    .prepare(
      `SELECT vr.verdict_json AS verdictJson
       FROM verification_attempts va
       JOIN verification_results vr ON vr.verification_attempt_id = va.id
       WHERE va.job_id = ? AND va.generation = ? AND va.scope_type = 'slice'
         AND va.scope_id = ? AND va.status = 'succeeded'
       ORDER BY va.attempt_number DESC, va.ended_at DESC
       LIMIT 1`
    )
    .get(jobId, generation, sliceId) as { verdictJson: string } | undefined
  return parseJson<SliceVerdict | null>(row?.verdictJson, null)
}

export function buildMilestoneVerificationEvidence(input: {
  db: Database.Database
  jobId: string
  generation: number
  milestoneId: string
}): MilestoneVerificationEvidenceBundle {
  const milestone = input.db
    .prepare(
      `SELECT id, source_milestone_id AS sourceMilestoneId, title, description,
              success_criteria AS successCriteria
       FROM job_milestones
       WHERE job_id = ? AND generation = ? AND id = ?`
    )
    .get(input.jobId, input.generation, input.milestoneId) as
    | {
        id: string
        sourceMilestoneId: string
        title: string
        description: string
        successCriteria: string
      }
    | undefined
  if (!milestone) throw new Error(`Verification milestone not found: ${input.milestoneId}`)

  const slices = input.db
    .prepare(
      `SELECT id, source_slice_id AS sourceSliceId, title, description,
              success_criteria AS successCriteria, state,
              verification_state AS verificationState
       FROM job_slices
       WHERE job_id = ? AND generation = ? AND milestone_id = ?
       ORDER BY sort_order, id`
    )
    .all(input.jobId, input.generation, input.milestoneId) as Array<{
    id: string
    sourceSliceId: string
    title: string
    description: string
    successCriteria: string
    state: string
    verificationState: string
  }>

  return {
    schemaVersion: 1,
    scopeType: 'milestone',
    jobId: input.jobId,
    generation: input.generation,
    job: readJobContext(input.db, input.jobId),
    milestone,
    slices: slices.map((slice) => ({
      ...slice,
      verdict: readLatestSliceVerdict(input.db, input.jobId, input.generation, slice.id)
    }))
  }
}

export function serializeVerificationEvidence(
  bundle: SliceVerificationEvidenceBundle | MilestoneVerificationEvidenceBundle
): string {
  return JSON.stringify(bundle)
}
