import { AppError } from '../error'
import { validateSetupCredentials } from '@codetask/contracts/auth'
import { formatTurnErrorMessage } from '@codetask/contracts/turn-errors/turn-error'

export function assertSetupCredentialsAllowed(username: string, password: string): void {
  const violation = validateSetupCredentials(username, password)
  if (!violation) return

  throw AppError.badRequest(
    formatTurnErrorMessage(violation.code, violation.params),
    violation.code,
    violation.params
  )
}
