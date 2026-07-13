export type TaskState = 'queued' | 'running' | 'completed' | 'blocked' | 'failed' | 'skipped'

export interface TaskRow {
  readonly jobId: string
  readonly executionGeneration: number
  readonly taskId: string
  readonly sourcePlanRevision: number
  readonly state: TaskState
  readonly sortOrder: number
  readonly originKind: string | null
  readonly parentTaskId: string | null
  readonly title: string
  readonly abilityCode: string | null
  readonly coreCode: string | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface TaskAttemptRow {
  readonly id: string
  readonly jobId: string
  readonly executionGeneration: number
  readonly taskId: string
  readonly attemptNo: number
  readonly runId: string
  readonly state: string
  readonly provider: string | null
  readonly evidenceBlobHash: string | null
  readonly failureId: string | null
  readonly startedAtMs: number
  readonly endedAtMs: number | null
  readonly resultHash: string | null
  readonly resultRevision: number | null
}

export interface EvidenceBlob {
  readonly hash: string
  readonly content: string
}

export interface TaskRepository {
  getCurrentTask(jobId: string, generation: number, taskId: string): TaskRow | null
  listTasksForGeneration(jobId: string, generation: number): readonly TaskRow[]
  updateTaskState(jobId: string, generation: number, taskId: string, expectedState: TaskState, nextState: TaskState): boolean
  /**
   * Creates the next execution-generation projection from the confirmed
   * projection currently in use. Historical generations remain immutable.
   */
  cloneTasksToGeneration(
    jobId: string,
    sourceGeneration: number,
    targetGeneration: number,
    createdAtMs: number
  ): number
  getAttempt(attemptId: string): TaskAttemptRow | null
  getRunningAttempt(attemptId: string): TaskAttemptRow | null
  finishAttempt(
    attemptId: string,
    resultHash: string,
    evidenceHash: string,
    resultRevision: number
  ): void
  createAttempt(jobId: string, generation: number, taskId: string, runId: string): string
  startAttempt(attemptId: string): boolean
  getTaskAttempts(jobId: string, generation: number, taskId: string): readonly TaskAttemptRow[]
}
