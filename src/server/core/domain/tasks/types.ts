export type TaskId = string & { readonly __brand: 'TaskId' }
export type AttemptId = string & { readonly __brand: 'AttemptId' }

export function asTaskId(id: string): TaskId {
  return id as TaskId
}

export function asAttemptId(id: string): AttemptId {
  return id as AttemptId
}

/** Attempt terminates at most once. */
export type AttemptStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'inconclusive'

export const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set([
  'succeeded',
  'failed',
  'inconclusive'
])

export interface Task {
  readonly id: TaskId
  readonly dependencyIds: readonly TaskId[]
  readonly title?: string
}

export interface TaskAttempt {
  readonly id: AttemptId
  readonly taskId: TaskId
  readonly executionGeneration: number
  readonly status: AttemptStatus
  readonly idempotencyKey: string
  readonly resultHash: string | null
  readonly errorCode: string | null
}

export function createTask(input: {
  readonly id: string
  readonly dependencyIds?: readonly string[]
  readonly title?: string
}): Task {
  return {
    id: asTaskId(input.id),
    dependencyIds: (input.dependencyIds ?? []).map(asTaskId),
    ...(input.title !== undefined ? { title: input.title } : {})
  }
}

export function createTaskAttempt(input: {
  readonly id: string
  readonly taskId: string
  readonly executionGeneration?: number
  readonly status?: AttemptStatus
  readonly idempotencyKey?: string
  readonly resultHash?: string | null
  readonly errorCode?: string | null
}): TaskAttempt {
  return {
    id: asAttemptId(input.id),
    taskId: asTaskId(input.taskId),
    executionGeneration: input.executionGeneration ?? 1,
    status: input.status ?? 'pending',
    idempotencyKey: input.idempotencyKey ?? `${input.taskId}:1`,
    resultHash: input.resultHash ?? null,
    errorCode: input.errorCode ?? null
  }
}
