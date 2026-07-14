import { reduceJobSnapshot, type VersionedEntity, type MergeDecision } from './entity-store'

export interface JobDto {
  readonly id: string
  readonly state: string
  readonly stateRevision: number
  readonly availableActions: readonly string[]
}

export class JobsStore {
  private readonly jobs = new Map<string, VersionedEntity<JobDto>>()
  private selectedJobId: string | null = null

  mergeJob(job: JobDto, source: 'incremental_event' | 'authoritative_snapshot'): MergeDecision {
    const current = this.jobs.get(job.id)
    const decision = reduceJobSnapshot(current, job, source)

    if (decision.kind === 'accept') {
      this.jobs.set(job.id, decision.next as VersionedEntity<JobDto>)
    }

    return decision
  }

  getJob(jobId: string): JobDto | undefined {
    return this.jobs.get(jobId)?.entity
  }

  getAllJobs(): readonly JobDto[] {
    return Array.from(this.jobs.values()).map(v => v.entity)
  }

  getSelectedJobId(): string | null {
    return this.selectedJobId
  }

  selectJob(jobId: string): void {
    this.selectedJobId = jobId
  }
}
