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
}

export interface EvidenceBlob {
  readonly hash: string
  readonly content: string
}

export interface TaskRepository {
  getCurrentTask(jobId: string, generation: number, taskId: string): TaskRow | null
  updateTaskState(jobId: string, generation: number, taskId: string, expectedState: TaskState, nextState: TaskState): boolean
  getRunningAttempt(attemptId: string): TaskAttemptRow | null
  finishAttempt(attemptId: string, resultHash: string, evidenceHash: string): void
  createAttempt(jobId: string, generation: number, taskId: string, runId: string): string
  startAttempt(attemptId: string): boolean
  getTaskAttempts(jobId: string, generation: number, taskId: string): readonly TaskAttemptRow[]
}
