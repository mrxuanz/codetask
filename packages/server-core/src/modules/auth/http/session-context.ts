import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuthPrincipal } from '../domain/actor.ts'
import { AuthError } from '../domain/auth-errors.ts'

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
    throw AuthError.unauthorized()
  }
  return principal
}

/** Stable Actor.userId (= auth_users.id). Use when a route only needs the ownership key. */
export function requireActorUserId(): string {
  return requireAuthPrincipal().userId
}

export function resolveSessionTokenFromRequest(input: {
  authHeader?: string
  accessToken?: string | null
}): string | undefined {
  const headerToken = bearerToken(input.authHeader)
  if (headerToken) return headerToken
  // Session tokens are never accepted from URLs. Attachments use a separate signed asset token.
  void input.accessToken
  return undefined
}
