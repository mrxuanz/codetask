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

export function planError(
  code: string,
  message: string,
  details?: Record<string, unknown>
): PlanDomainError {
  return new PlanDomainError(code, message, details)
}
