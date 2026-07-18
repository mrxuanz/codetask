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
  readonly mustPauseAtCommit: boolean | null
}

export interface TaskRepository {
  getCurrentTask(jobId: string, generation: number, taskId: string): TaskRow | null
  listTasksForGeneration(jobId: string, generation: number): readonly TaskRow[]
  updateTaskState(
    jobId: string,
    generation: number,
    taskId: string,
    expectedState: TaskState,
    nextState: TaskState,
    updatedAtMs: number
  ): boolean
  cloneTasksToGeneration(
    jobId: string,
    sourceGeneration: number,
    targetGeneration: number,
    createdAtMs: number
  ): number
  getAttempt(attemptId: string): TaskAttemptRow | null
  getRunningAttempt(attemptId: string): TaskAttemptRow | null
  getPendingAttemptForRun(runId: string): TaskAttemptRow | null
  finishAttempt(
    attemptId: string,
    resultHash: string,
    evidenceHash: string,
    resultRevision: number,
    endedAtMs: number,
    mustPauseAtCommit?: boolean
  ): void
  createAttempt(input: {
    readonly id: string
    readonly jobId: string
    readonly generation: number
    readonly taskId: string
    readonly runId: string
    readonly state: 'pending' | 'running' | 'starting'
    readonly startedAtMs: number
    readonly attemptNo?: number
  }): void
  startAttempt(attemptId: string): boolean
  getTaskAttempts(jobId: string, generation: number, taskId: string): readonly TaskAttemptRow[]
}
