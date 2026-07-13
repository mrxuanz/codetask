import type { JobState, JobAction } from '@shared/contracts/control-plane'
import type { JobAggregateView } from './ports/job-repository'
import { availableActions } from '../domain/jobs/job-action-rules'

export interface JobDto {
  readonly id: string
  readonly threadId: string
  readonly projectId: string
  readonly state: JobState
  readonly stateRevision: number
  readonly controlIntent: string
  readonly resumeTarget: string | null
  readonly currentPlanRevision: number | null
  readonly executionGeneration: number
  readonly activeRunId: string | null
  readonly lastFailureId: string | null
  readonly availableActions: readonly JobAction[]
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly terminalAtMs: number | null
}

export interface JobQueryService {
  getJob(jobId: string, actor: { username: string }): JobDto | null
  listJobs(actor: { username: string }, projectId?: string): readonly JobDto[]
}

export interface JobQueryDependencies {
  readonly getJobAggregate: (jobId: string) => JobAggregateView | null
  readonly listJobAggregates: (projectId?: string) => readonly JobAggregateView[]
  readonly getJobTimestamps: (jobId: string) => { createdAtMs: number; updatedAtMs: number; terminalAtMs: number | null } | null
}

export class JobQueryServiceImpl implements JobQueryService {
  constructor(private readonly deps: JobQueryDependencies) {}

  getJob(jobId: string, _actor: { username: string }): JobDto | null {
    const job = this.deps.getJobAggregate(jobId)
    if (!job) return null

    const timestamps = this.deps.getJobTimestamps(jobId)

    return this.toDto(job, timestamps)
  }

  listJobs(_actor: { username: string }, projectId?: string): readonly JobDto[] {
    const jobs = this.deps.listJobAggregates(projectId)
    return jobs.map((job) => {
      const timestamps = this.deps.getJobTimestamps(job.id)
      return this.toDto(job, timestamps)
    })
  }

  private toDto(
    job: JobAggregateView,
    timestamps: { createdAtMs: number; updatedAtMs: number; terminalAtMs: number | null } | null
  ): JobDto {
    const actions = availableActions({
      state: job.state,
      recoverability: null,
      hasConfirmedPlan: job.currentPlanRevision !== null
    })

    return {
      id: job.id,
      threadId: job.threadId,
      projectId: job.projectId,
      state: job.state,
      stateRevision: job.stateRevision,
      controlIntent: job.controlIntent,
      resumeTarget: job.resumeTarget,
      currentPlanRevision: job.currentPlanRevision,
      executionGeneration: job.executionGeneration,
      activeRunId: job.activeRunId,
      lastFailureId: job.lastFailureId,
      availableActions: actions,
      createdAtMs: timestamps?.createdAtMs ?? 0,
      updatedAtMs: timestamps?.updatedAtMs ?? 0,
      terminalAtMs: timestamps?.terminalAtMs ?? null
    }
  }
}
