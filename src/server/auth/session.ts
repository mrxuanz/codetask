import { AsyncLocalStorage } from 'node:async_hooks'
import { AppError } from '../error'
import { TURN_ERROR_DEFAULT_MESSAGES } from '../../shared/turn-errors/codes.ts'
import type { AuthPrincipal } from './store'

const principalStorage = new AsyncLocalStorage<AuthPrincipal>()

export function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader?.startsWith('Bearer ')) return undefined
  const token = authHeader.slice(7).trim()
  return token || undefined
}

export function currentAuthPrincipal(): AuthPrincipal | undefined {
  return principalStorage.getStore()
}

export function runWithAuthPrincipal<T>(principal: AuthPrincipal, action: () => T): T {
  return principalStorage.run(principal, action)
}

export function requireAuthPrincipal(): AuthPrincipal {
  const principal = currentAuthPrincipal()
  if (!principal) {
    throw AppError.unauthorized(TURN_ERROR_DEFAULT_MESSAGES['auth.unauthorized'])
  }
  return principal
}

export async function requireUsername(_authHeader?: string): Promise<string> {
  const ambient = currentAuthPrincipal()
  if (ambient) return ambient.username
  throw AppError.unauthorized(TURN_ERROR_DEFAULT_MESSAGES['auth.unauthorized'])
}

export function resolveSessionTokenFromRequest(input: {
  authHeader?: string
  accessToken?: string | null
}): string | undefined {
  const headerToken = bearerToken(input.authHeader)
  if (headerToken) return headerToken
  // Session tokens are never accepted from URLs. Attachments use a separate signed asset token.
  return undefined
}

export async function requireUsernameFromRequest(input: {
  authHeader?: string
  accessToken?: string | null
}): Promise<string> {
  const ambient = currentAuthPrincipal()
  if (ambient) return ambient.username
  void input
  throw AppError.unauthorized(TURN_ERROR_DEFAULT_MESSAGES['auth.unauthorized'])
}
