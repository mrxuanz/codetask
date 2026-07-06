import { AppError } from '../error'
import { formatTurnErrorMessage } from '../../shared/turn-errors/turn-error'
import { validateSetupCredentials } from '../../shared/auth/credentials-policy'

export function assertSetupCredentialsAllowed(username: string, password: string): void {
  const violation = validateSetupCredentials(username, password)
  if (!violation) return

  throw AppError.badRequest(
    formatTurnErrorMessage(violation.code, violation.params),
    violation.code,
    violation.params
  )
}
