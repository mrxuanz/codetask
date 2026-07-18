export class PlanDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'PlanDomainError'
  }
}

export function planValidationError(code: string, details?: Record<string, unknown>): PlanDomainError {
  return new PlanDomainError(code, code, details)
}
