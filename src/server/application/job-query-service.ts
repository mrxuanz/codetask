import type { JobState, JobAction, ResumeTarget } from '@shared/contracts/control-plane'
import type { ThreadJobDto, ThreadJobStatus } from '@shared/contracts/jobs'
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
  getTaskJob(jobId: string, actor: { username: string }): Promise<TaskJobSnapshotDto | null>
  listTaskJobs(
    actor: { username: string },
    options?: TaskJobListOptions
  ): Promise<{ jobs: readonly TaskJobSnapshotDto[]; total: number }>
}

export interface JobQueryDependencies {
  readonly getJobAggregate: (actor: { username: string }, jobId: string) => JobAggregateView | null
  readonly listJobAggregates: (
    actor: { username: string },
    projectId?: string
  ) => readonly JobAggregateView[]
  readonly getLegacyJobSnapshot: (
    actor: { username: string },
    jobId: string
  ) => Promise<ThreadJobDto | null>
  readonly listLegacyJobSnapshots: (
    actor: { username: string },
    options?: TaskJobListOptions
  ) => Promise<{ jobs: ThreadJobDto[]; total: number }>
  readonly getJobTimestamps: (jobId: string) => { createdAtMs: number; updatedAtMs: number; terminalAtMs: number | null } | null
}

export interface TaskJobListOptions {
  readonly projectId?: string
  readonly status?: string
  readonly page?: number
  readonly limit?: number
  readonly q?: string
}

export interface TaskJobSnapshotDto extends ThreadJobDto {
  readonly state?: JobState
  readonly projectId?: string
  readonly controlIntent?: string
  readonly resumeTarget?: ResumeTarget | null
  readonly currentPlanRevision?: number | null
  readonly executionGeneration?: number
  readonly activeRunId?: string | null
  readonly lastFailureId?: string | null
  readonly createdAtMs?: number
  readonly updatedAtMs?: number
  readonly terminalAtMs?: number | null
}

function mapStateToLegacyStatus(state: JobState): ThreadJobStatus | null {
  switch (state) {
    case 'planning_queued':
    case 'execution_queued':
      return 'pending'
    case 'planning_running':
      return 'planning'
    case 'plan_review':
      return 'plan_ready'
    case 'execution_running':
      return 'running'
    case 'pausing':
      return 'pausing'
    case 'paused':
      return 'paused'
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return null
  }
}

export class JobQueryServiceImpl implements JobQueryService {
  constructor(private readonly deps: JobQueryDependencies) {}

  getJob(jobId: string, actor: { username: string }): JobDto | null {
    const job = this.deps.getJobAggregate(actor, jobId)
    if (!job) return null

    const timestamps = this.deps.getJobTimestamps(jobId)

    return this.toDto(job, timestamps)
  }

  listJobs(actor: { username: string }, projectId?: string): readonly JobDto[] {
    const jobs = this.deps.listJobAggregates(actor, projectId)
    return jobs.map((job) => {
      const timestamps = this.deps.getJobTimestamps(job.id)
      return this.toDto(job, timestamps)
    })
  }

  async getTaskJob(
    jobId: string,
    actor: { username: string }
  ): Promise<TaskJobSnapshotDto | null> {
    const [legacy, aggregate] = await Promise.all([
      this.deps.getLegacyJobSnapshot(actor, jobId),
      Promise.resolve(this.deps.getJobAggregate(actor, jobId))
    ])

    if (!legacy) {
      return null
    }

    return this.toTaskSnapshot(legacy, aggregate)
  }

  async listTaskJobs(
    actor: { username: string },
    options?: TaskJobListOptions
  ): Promise<{ jobs: readonly TaskJobSnapshotDto[]; total: number }> {
    const result = await this.deps.listLegacyJobSnapshots(actor, options)
    return {
      jobs: result.jobs.map((job) =>
        this.toTaskSnapshot(job, this.deps.getJobAggregate(actor, job.id))
      ),
      total: result.total
    }
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

  private toTaskSnapshot(
    legacy: ThreadJobDto,
    aggregate: JobAggregateView | null
  ): TaskJobSnapshotDto {
    if (aggregate === null) {
      return legacy
    }

    const timestamps = this.deps.getJobTimestamps(aggregate.id)
    const status = mapStateToLegacyStatus(aggregate.state) ?? legacy.status
    const control = this.toDto(aggregate, timestamps)

    return {
      ...legacy,
      status,
      state: control.state,
      projectId: control.projectId,
      stateRevision: control.stateRevision,
      availableActions: [...control.availableActions],
      controlIntent: control.controlIntent,
      resumeTarget: control.resumeTarget,
      currentPlanRevision: control.currentPlanRevision,
      executionGeneration: control.executionGeneration,
      activeRunId: control.activeRunId,
      lastFailureId: control.lastFailureId,
      createdAtMs: control.createdAtMs,
      updatedAtMs: control.updatedAtMs,
      terminalAtMs: control.terminalAtMs
    }
  }
}
