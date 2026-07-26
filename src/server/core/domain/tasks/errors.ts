export type TaskErrorCode =
  | 'task.illegal_transition'
  | 'task.attempt_already_terminal'
  | 'task.not_ready'

export class TaskDomainError extends Error {
  readonly code: TaskErrorCode
  readonly details: Record<string, unknown>

  constructor(code: TaskErrorCode, message?: string, details: Record<string, unknown> = {}) {
    super(message ?? code)
    this.name = 'TaskDomainError'
    this.code = code
    this.details = details
  }
}

export function illegalAttemptTransition(
  status: string,
  command: string
): TaskDomainError {
  return new TaskDomainError(
    status === 'succeeded' || status === 'failed' || status === 'inconclusive'
      ? 'task.attempt_already_terminal'
      : 'task.illegal_transition',
    `cannot ${command} from attempt status=${status}`,
    { status, command }
  )
}
