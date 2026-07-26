import type { Task, TaskAttempt } from '../../domain/tasks/types'

/** Projection status for a plan task within a job generation. */
export type ProjectedTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface ProjectedTask {
  readonly jobId: string
  readonly executionGeneration: number
  readonly task: Task
  readonly status: ProjectedTaskStatus
  readonly sliceId?: string
  readonly milestoneId?: string
}

export interface TaskProjectionRepo {
  listForJob(jobId: string, executionGeneration: number): Promise<readonly ProjectedTask[]>
  get(
    jobId: string,
    executionGeneration: number,
    taskId: string
  ): Promise<ProjectedTask | undefined>
  save(record: ProjectedTask): Promise<void>
}

export interface AttemptRepo {
  get(id: string): Promise<TaskAttempt | undefined>
  save(attempt: TaskAttempt, opts?: { readonly jobId?: string }): Promise<void>
  listForTask(
    jobId: string,
    taskId: string,
    executionGeneration: number
  ): Promise<readonly TaskAttempt[]>
  /** Non-terminal attempts across all jobs (startup reconcile). */
  listNonTerminal(): Promise<readonly (TaskAttempt & { readonly jobId: string })[]>
}
