export class TaskDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'TaskDomainError'
  }
}

export function taskResultError(code: string, details?: Record<string, unknown>): TaskDomainError {
  return new TaskDomainError(code, code, details)
}
