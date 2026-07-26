import { DomainError } from '../shared/errors'

export class VerificationDomainError extends DomainError {
  constructor(code: string, message?: string, details?: Record<string, unknown>) {
    super(code, message ?? code, details)
    this.name = 'VerificationDomainError'
  }
}

export function verificationError(
  code: string,
  message?: string,
  details?: Record<string, unknown>
): VerificationDomainError {
  return new VerificationDomainError(code, message, details)
}
