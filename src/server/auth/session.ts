import type { Context } from 'hono'
import type { AuthPrincipal } from '../core/application/auth'
import { AppError } from '../error'
import { TURN_ERROR_DEFAULT_MESSAGES } from '../../shared/turn-errors/codes.ts'

type AuthenticatedContext = Context<{
  Variables: {
    authPrincipal: AuthPrincipal
  }
}>

export function setRequestAuthPrincipal(context: Context, principal: AuthPrincipal): void {
  ;(context as AuthenticatedContext).set('authPrincipal', principal)
}

export function getRequestAuthPrincipal(context: Context): AuthPrincipal | null {
  return (context as AuthenticatedContext).get('authPrincipal') ?? null
}

export async function requireUsername(context: Context): Promise<string> {
  const principal = getRequestAuthPrincipal(context)
  if (!principal) {
    throw AppError.unauthorized(TURN_ERROR_DEFAULT_MESSAGES['auth.session_expired'])
  }
  return principal.username
}
