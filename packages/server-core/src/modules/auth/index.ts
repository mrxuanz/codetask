import { composeAuthModule, type AuthModule, type AuthModuleDeps } from './composition.ts'

export type { AuthModule, AuthModuleDeps }
export { composeAuthModule }

export type { Actor, AuthPrincipal } from './domain/actor.ts'
export type { Session } from './domain/session.ts'
export { principalToActor, toModuleActor } from './domain/actor.ts'
export { AuthError } from './domain/auth-errors.ts'
export { LoginPolicy, normalizeUsername } from './domain/login-policy.ts'

export {
  AuthApplication,
  sessionIssueToAuthData,
  type AuthData,
  type BootstrapData,
  type CaptchaChallenge,
  type LoginOptions,
  type SessionIssue
} from './application/auth-application.ts'

export { SqliteAuthRepository } from './infrastructure/sqlite-auth-repository.ts'
export {
  HmacTokenDigester,
  ScryptPasswordHasher,
  hmacParts
} from './infrastructure/scrypt-password-hasher.ts'
export { acquirePasswordSlot } from './infrastructure/password-limiter.ts'

export {
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  clearSessionCookies,
  createCsrfToken,
  issueSessionCookies,
  readSessionCredential,
  requestHasValidCsrf,
  verifyCsrfToken,
  type SessionCredential
} from './http/cookie-session.ts'

export {
  bearerToken,
  currentAuthPrincipal,
  requireActorUserId,
  requireAuthPrincipal,
  resolveSessionTokenFromRequest,
  runWithAuthPrincipal
} from './http/session-context.ts'

export { createAuthHttpRoutes, type AuthHttpDeps } from './http/auth-routes.ts'
