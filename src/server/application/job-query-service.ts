import type { JobState, JobAction, ResumeTarget, Recoverability } from '@shared/contracts/control-plane'
import type {
  ThreadJobDto,
  ThreadJobStatus,
  PlanProgressDto,
  TaskProgressDto,
  TaskProgressItemDto
} from '@shared/contracts/jobs'
import type { JobFailureDto, JobRecoveryDto } from '../../shared/job-recovery-state'
import type { JobDetailView } from './ports/job-repository'
import type { TaskRow } from './ports/task-repository'
import { availableActions } from '../domain/jobs/job-action-rules'
import { defaultPlanProgress, defaultTaskProgress } from '../planner/save-plan'

export interface JobDto {
  readonly id: string
  readonly threadId: string
  readonly projectId: string
  readonly state: JobState
  readonly stateRevision: number
  readonly controlIntent: string
  readonly resumeTarget: ResumeTarget | null
  readonly currentPlanRevision: number | null
  readonly executionGeneration: number
  readonly activeRunId: string | null
  readonly lastFailureId: string | null
  readonly failure: JobFailureProjection | null
  readonly availableActions: readonly JobAction[]
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly terminalAtMs: number | null
}

export interface JobFailureProjection {
  readonly code: string
  readonly recoverability: string
  readonly reason: string | null
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
  readonly getOwnedJobDetail: (
    actor: { username: string },
    jobId: string
  ) => JobDetailView | null
  readonly listOwnedJobDetails: (
    actor: { username: string },
    options?: TaskJobListOptions
  ) => { jobs: readonly JobDetailView[]; total: number }
  readonly listTasksForGeneration: (
    jobId: string,
    executionGeneration: number
  ) => readonly TaskRow[]
  readonly getJobFailure?: (failureId: string) => JobFailureProjection | null
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

function mapStateToLegacyStatus(state: JobState): ThreadJobStatus {
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
      return 'pending'
  }
}

function toRecoverability(failure: JobFailureProjection | null): Recoverability | null {
  if (failure === null) return null
  return failure.recoverability === 'recoverable' ? 'recoverable' : 'non_recoverable'
}

function mapTaskState(state: TaskRow['state']): TaskProgressItemDto['status'] {
  switch (state) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
    case 'blocked':
      return 'failed'
    case 'skipped':
      return 'skipped'
    default:
      return 'queued'
  }
}

function buildPlanProgress(job: JobDetailView): PlanProgressDto {
  const base = defaultPlanProgress()
  switch (job.state) {
    case 'planning_queued':
    case 'planning_running':
      return { ...base, phase: 'planning', status: 'running' }
    case 'plan_review':
      return { ...base, phase: 'plan_ready', status: 'completed' }
    case 'failed':
      if (job.currentPlanRevision === null) {
        return { ...base, phase: 'failed', status: 'failed' }
      }
      return { ...base, phase: 'plan_ready', status: 'completed' }
    default:
      return job.currentPlanRevision === null
        ? base
        : { ...base, phase: 'plan_ready', status: 'completed' }
  }
}

function buildTaskProgress(
  tasks: readonly TaskRow[],
  job: JobDetailView
): TaskProgressDto {
  if (tasks.length === 0) {
    return defaultTaskProgress()
  }

  const items: TaskProgressItemDto[] = tasks.map((task) => ({
    id: task.taskId,
    title: task.title,
    status: mapTaskState(task.state),
    abilityCode: task.abilityCode ?? undefined,
    executionStatus: mapTaskState(task.state),
    evidenceStatus: null,
    errorMessage: null,
    coreCode: task.coreCode ?? undefined
  }))

  const runningIndex = items.findIndex((task) => task.status === 'running')
  const currentIndex = runningIndex >= 0 ? runningIndex : items.findIndex((task) => task.status === 'queued')
  const phase =
    job.state === 'succeeded'
      ? 'completed'
      : job.state === 'failed'
        ? 'failed'
        : runningIndex >= 0
          ? 'running'
          : 'idle'
  const status =
    phase === 'completed'
      ? 'completed'
      : phase === 'failed'
        ? 'failed'
        : phase === 'running'
          ? 'running'
          : 'pending'

  return {
    phase,
    status,
    currentIndex: currentIndex >= 0 ? currentIndex : 0,
    total: items.length,
    currentTaskId: currentIndex >= 0 ? items[currentIndex]?.id ?? null : null,
    message: null,
    tasks: items
  }
}

function buildFailureFields(
  failure: JobFailureProjection | null
): { failure?: JobFailureDto; recovery?: JobRecoveryDto } {
  if (failure === null) return {}
  const recoverable = failure.recoverability === 'recoverable'
  return {
    failure: {
      kind: null,
      message: failure.reason,
      taskId: null
    },
    recovery: {
      recoverable,
      strategy: null,
      reason: failure.reason,
      nextAction: null,
      failedTaskId: null,
      autoRetryAttempt: 0,
      maxAutoRetryAttempts: 0,
      repairGeneration: 0,
      maxRepairGenerations: 0
    }
  }
}

export class JobQueryServiceImpl implements JobQueryService {
  constructor(private readonly deps: JobQueryDependencies) {}

  getJob(jobId: string, actor: { username: string }): JobDto | null {
    const job = this.deps.getOwnedJobDetail(actor, jobId)
    if (!job) return null
    return this.toDto(job)
  }

  listJobs(actor: { username: string }, projectId?: string): readonly JobDto[] {
    const result = this.deps.listOwnedJobDetails(
      actor,
      projectId === undefined ? {} : { projectId }
    )
    return result.jobs.map((job) => this.toDto(job))
  }

  async getTaskJob(
    jobId: string,
    actor: { username: string }
  ): Promise<TaskJobSnapshotDto | null> {
    const job = this.deps.getOwnedJobDetail(actor, jobId)
    if (job === null) return null
    return this.buildTaskSnapshot(job)
  }

  async listTaskJobs(
    actor: { username: string },
    options?: TaskJobListOptions
  ): Promise<{ jobs: readonly TaskJobSnapshotDto[]; total: number }> {
    const result = this.deps.listOwnedJobDetails(actor, options)
    return {
      jobs: result.jobs.map((job) => this.buildTaskSnapshot(job)),
      total: result.total
    }
  }

  private toDto(job: JobDetailView): JobDto {
    const failure =
      job.lastFailureId === null ? null : (this.deps.getJobFailure?.(job.lastFailureId) ?? null)
    const recoverability = toRecoverability(failure)
    const actions = availableActions({
      state: job.state,
      recoverability,
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
      failure,
      availableActions: actions,
      createdAtMs: job.createdAtMs,
      updatedAtMs: job.updatedAtMs,
      terminalAtMs: job.terminalAtMs
    }
  }

  private buildTaskSnapshot(job: JobDetailView): TaskJobSnapshotDto {
    const control = this.toDto(job)
    const tasks = this.deps.listTasksForGeneration(job.id, job.executionGeneration)
    const failureFields = buildFailureFields(control.failure)

    return {
      id: job.id,
      threadId: job.threadId,
      draftMessageId: job.draftMessageId,
      title: job.title,
      summary: job.requirementsSummary,
      status: mapStateToLegacyStatus(job.state),
      planProgress: buildPlanProgress(job),
      taskProgress: buildTaskProgress(tasks, job),
      abilities: [],
      planRevision: job.currentPlanRevision,
      draftConfirmedAt: null,
      planConfirmedAt: job.currentPlanRevision === null ? null : job.updatedAtMs,
      designSessionId: null,
      snapshotDraftRevision: null,
      snapshotPlanRevision: job.currentPlanRevision,
      snapshotManifestRevision: null,
      createdAt: job.createdAtMs,
      updatedAt: job.updatedAtMs,
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
      terminalAtMs: control.terminalAtMs,
      ...failureFields
    }
  }
}
