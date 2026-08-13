import type {
  JobDetail,
  JobListResult,
  JobState,
  JobSummary,
  JobTreeDto
} from '@codetask/contracts'
import type { Actor } from '../../shared.ts'
import { ExecutionForbiddenError, ExecutionValidationError } from '../../shared.ts'
import type { WorkItemRecord } from '../../work/domain/work-item.ts'
import { JobRepository } from '../infrastructure/job-repository.ts'
import { QueueRepository } from '../../queue/infrastructure/queue-repository.ts'
import { WorkRepository } from '../../work/infrastructure/work-repository.ts'
import { VerificationRepository } from '../../verification/infrastructure/verification-repository.ts'

export class QueryJobService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly queue: QueueRepository,
    private readonly work: WorkRepository,
    private readonly verification: VerificationRepository
  ) {}

  private assertOwner(actor: Actor, actorId: string): void {
    if (actor.userId !== actorId) throw new ExecutionForbiddenError()
  }

  list(actor: Actor): JobSummary[] {
    const rows = this.jobs.listByActor(actor.userId)
    return rows.map((job) =>
      this.jobs.toSummary(job, this.queue.getPosition(job.id, job.executionGeneration))
    )
  }

  listPage(
    actor: Actor,
    options: { status?: string; page?: number; limit?: number; query?: string } = {}
  ): JobListResult {
    const page = options.page ?? 1
    const limit = options.limit ?? 50
    if (!Number.isInteger(page) || page < 1) {
      throw new ExecutionValidationError('page must be a positive integer')
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ExecutionValidationError('limit must be an integer between 1 and 200')
    }

    const status = normalizeListStatus(options.status)
    const query = options.query?.trim().toLowerCase() ?? ''
    const result = this.jobs.listPageByActor({
      actorId: actor.userId,
      state: status,
      query,
      page,
      limit
    })
    const jobs = result.jobs.map((job) =>
      this.jobs.toDetail(job, this.queue.getPosition(job.id, job.executionGeneration))
    )
    return { jobs, total: result.total, page, limit }
  }

  get(actor: Actor, jobId: string): JobDetail {
    const job = this.jobs.requireById(jobId)
    this.assertOwner(actor, job.actorId)
    return this.jobs.toDetail(job, this.queue.getPosition(job.id, job.executionGeneration))
  }

  getTree(actor: Actor, jobId: string): JobTreeDto {
    const job = this.jobs.requireById(jobId)
    this.assertOwner(actor, job.actorId)
    return this.jobs.getTree(jobId, job.executionGeneration)
  }

  getWork(actor: Actor, jobId: string, workId: string): WorkItemRecord {
    const job = this.jobs.requireById(jobId)
    this.assertOwner(actor, job.actorId)
    return this.work.requireWork(jobId, workId)
  }

  getEvidence(
    actor: Actor,
    jobId: string,
    workId: string
  ): {
    status: unknown
    summary: unknown
    changedFiles: unknown
    validation: unknown
    evidenceSummary: unknown
    resultHash: unknown
  } | null {
    const job = this.jobs.requireById(jobId)
    this.assertOwner(actor, job.actorId)
    const evidence = this.work.getEvidenceForWork(jobId, workId)
    if (!evidence) return null
    return {
      status: evidence.status,
      summary: evidence.summary,
      changedFiles: JSON.parse(String(evidence.changed_files_json)),
      validation: JSON.parse(String(evidence.validation_json)),
      evidenceSummary: evidence.evidence_summary,
      resultHash: evidence.result_hash
    }
  }

  listVerifications(
    actor: Actor,
    jobId: string
  ): Array<{
    scopeType: unknown
    scopeId: unknown
    status: unknown
    confidence: unknown
    summary: unknown
    verdict: unknown
    createdAt: unknown
  }> {
    const job = this.jobs.requireById(jobId)
    this.assertOwner(actor, job.actorId)
    return this.verification.listVerifications(jobId).map((row) => ({
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      status: row.status,
      confidence: row.confidence,
      summary: row.summary,
      verdict: JSON.parse(String(row.verdict_json)),
      createdAt: row.created_at
    }))
  }
}

const JOB_STATES = new Set<JobState>([
  'queued',
  'running',
  'pausing',
  'paused',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled'
])

function normalizeListStatus(status: string | undefined): JobState | null {
  const normalized = status?.trim().toLowerCase()
  if (!normalized || normalized === 'all') return null
  if (normalized === 'completed') return 'succeeded'
  if (JOB_STATES.has(normalized as JobState)) return normalized as JobState
  throw new ExecutionValidationError(`Unsupported job status filter: ${status}`)
}
