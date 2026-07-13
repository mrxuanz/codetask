export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export function commandError(code: string, details?: Record<string, unknown>): DomainError {
  return new DomainError(code, code, details)
}

export function fromTransitionError(error: { code: string; state: string; command: string }): DomainError {
  return new DomainError(error.code, `${error.command} not allowed in state ${error.state}`, {
    state: error.state,
    command: error.command
  })
}
