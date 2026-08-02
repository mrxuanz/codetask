import { Type, type Static } from '@sinclair/typebox'

/** Stable authenticated actor passed into business modules (04 §5.1). */
export const ActorSchema = Type.Object({
  userId: Type.String(),
  username: Type.String(),
  sessionId: Type.String(),
  sessionExpiresAt: Type.Number()
})

export type Actor = Static<typeof ActorSchema>

export const AuthBootstrapSchema = Type.Object({
  initialized: Type.Boolean(),
  authenticated: Type.Boolean(),
  setupTokenRequired: Type.Boolean(),
  actor: Type.Optional(
    Type.Object({
      userId: Type.String(),
      username: Type.String(),
      sessionExpiresAt: Type.Number()
    })
  )
})

export type AuthBootstrap = Static<typeof AuthBootstrapSchema>

export const BrowserLoginResultSchema = Type.Object({
  actor: Type.Object({
    userId: Type.String(),
    username: Type.String(),
    sessionExpiresAt: Type.Number()
  })
})

export type BrowserLoginResult = Static<typeof BrowserLoginResultSchema>

export const BearerLoginResultSchema = Type.Object({
  token: Type.String(),
  actor: Type.Object({
    userId: Type.String(),
    username: Type.String(),
    sessionExpiresAt: Type.Number()
  })
})

export type BearerLoginResult = Static<typeof BearerLoginResultSchema>

/** Auth domain error codes (04 §15). */
export const AUTH_ERROR_CODES = [
  'auth.not_initialized',
  'auth.already_initialized',
  'auth.invalid_setup_token',
  'auth.invalid_credentials',
  'auth.captcha_required',
  'auth.captcha_invalid',
  'auth.account_locked',
  'auth.rate_limited',
  'auth.unauthorized',
  'auth.session_expired',
  'auth.csrf_invalid',
  'auth.origin_forbidden',
  'auth.current_password_invalid',
  'auth.credentials_policy_failed',
  'auth.username_password_required'
] as const

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number]
