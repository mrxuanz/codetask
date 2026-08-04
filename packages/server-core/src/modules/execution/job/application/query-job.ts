import type { JobDetail, JobSummary, JobTreeDto } from '@codetask/contracts'
import type { Actor } from '../../shared.ts'
import { ExecutionForbiddenError } from '../../shared.ts'
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
