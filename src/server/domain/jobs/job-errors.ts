export class CommandError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: 400 | 404 | 409 | 410 | 503,
    readonly details?: Record<string, unknown>
  ) {
    super(code)
    this.name = 'CommandError'
  }
}

/** @deprecated Use CommandError for command failures. */
export class DomainError extends CommandError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, commandErrorStatus(code), details)
    this.message = message
    this.name = 'DomainError'
  }
}

function commandErrorStatus(code: string): 400 | 404 | 409 | 410 | 503 {
  switch (code) {
    case 'contract.invalid_payload':
      return 400
    case 'job.not_found':
      return 404
    case 'api.legacy_blocked':
      return 410
    case 'app.draining':
      return 503
    default:
      return 409
  }
}

export function commandError(code: string, details?: Record<string, unknown>): CommandError {
  return new CommandError(code, commandErrorStatus(code), details)
}

export function fromTransitionError(error: {
  code: string
  state: string
  command: string
}): CommandError {
  return commandError(error.code, {
    state: error.state,
    command: error.command
  })
}
