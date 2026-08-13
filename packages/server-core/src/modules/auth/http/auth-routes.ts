import { Hono, type Context } from 'hono'
import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import {
  PASSWORD_MAX_LENGTH,
  USERNAME_MAX_LENGTH
} from '@codetask/contracts/auth/credentials-policy'
import type {
  AuthApplication,
  LoginOptions,
  SessionIssue
} from '../application/auth-application.ts'
import { AuthError } from '../domain/auth-errors.ts'
import {
  clearSessionCookies,
  issueSessionCookies,
  readSessionCredential
} from './cookie-session.ts'
import { requireAuthPrincipal } from './session-context.ts'

const SetupBodySchema = Type.Object(
  {
    username: Type.Optional(Type.String({ maxLength: USERNAME_MAX_LENGTH })),
    password: Type.Optional(Type.String({ maxLength: PASSWORD_MAX_LENGTH })),
    setupToken: Type.Optional(Type.String({ maxLength: 512 }))
  },
  { additionalProperties: false }
)
const LoginBodySchema = Type.Object(
  {
    username: Type.Optional(Type.String({ maxLength: USERNAME_MAX_LENGTH })),
    password: Type.Optional(Type.String({ maxLength: PASSWORD_MAX_LENGTH })),
    captchaId: Type.Optional(Type.String({ maxLength: 64 })),
    captchaAnswer: Type.Optional(Type.String({ maxLength: 16 }))
  },
  { additionalProperties: false }
)
const ChangePasswordBodySchema = Type.Object(
  {
    currentPassword: Type.Optional(Type.String({ maxLength: PASSWORD_MAX_LENGTH })),
    newPassword: Type.Optional(Type.String({ maxLength: PASSWORD_MAX_LENGTH }))
  },
  { additionalProperties: false }
)

export type AuthHttpDeps = {
  auth: AuthApplication
  authSecret: string
  mode: 'desktop' | 'server'
  getClientIp: (c: Context) => string
  validateSetupToken: (setupToken: string) => boolean
  clearSetupGate: () => void
  /** Map AuthError / domain failures into host HTTP JSON (status + body). */
  onAuthError: (error: unknown, c: Context) => Response | Promise<Response>
  ok: <T>(data: T, requestId: string) => unknown
  onSessionRevoked?: (input: {
    userId?: string
    sessionId?: string
    scope: 'session' | 'user'
  }) => void
}

function wantsBearerToken(c: Context): boolean {
  return c.req.header('x-codetask-auth-transport')?.toLowerCase() === 'bearer'
}

function requestId(c: Context): string {
  return (c.get('requestId' as never) as string | undefined) ?? 'unknown'
}

async function parseAuthBody<T>(c: Context, schema: TSchema): Promise<T> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw AuthError.badRequest('auth.invalid_payload', 'Request body must be valid JSON')
  }
  if (!Value.Check(schema, body)) {
    throw AuthError.badRequest('auth.invalid_payload', 'Invalid authentication request body')
  }
  return body as T
}

function browserActorPayload(issue: SessionIssue): {
  actor: { userId: string; username: string; sessionExpiresAt: number }
} {
  return {
    actor: {
      userId: issue.userId,
      username: issue.username,
      sessionExpiresAt: issue.expiresAt
    }
  }
}

function responsePayload(
  c: Context,
  issue: SessionIssue
): ReturnType<typeof browserActorPayload> & { token?: string } {
  if (wantsBearerToken(c)) {
    return {
      token: issue.token,
      ...browserActorPayload(issue)
    }
  }
  return browserActorPayload(issue)
}

function issue(c: Context, deps: AuthHttpDeps, issueData: SessionIssue): void {
  issueSessionCookies(c, {
    token: issueData.token,
    expiresAtSec: issueData.expiresAt,
    authSecret: deps.authSecret
  })
}

/**
 * Auth HTTP routes mounted at `/auth` (full paths `/api/auth/*`).
 */
export function createAuthHttpRoutes(deps: AuthHttpDeps): Hono {
  const routes = new Hono()
  const auth = deps.auth

  routes.onError(async (error, c) => {
    if (error instanceof AuthError) {
      return deps.onAuthError(error, c)
    }
    return deps.onAuthError(error, c)
  })

  routes.get('/bootstrap', async (c) => {
    const credential = readSessionCredential(c)
    const data = await auth.bootstrap(credential.token)
    return c.json(
      deps.ok(
        {
          ...data,
          setupTokenRequired: deps.mode === 'server' && !data.initialized
        },
        requestId(c)
      )
    )
  })

  routes.post('/setup', async (c) => {
    const precheck = await auth.bootstrap()
    const body = await parseAuthBody<Static<typeof SetupBodySchema>>(c, SetupBodySchema)
    if (deps.mode === 'server') {
      if (precheck.initialized) {
        throw AuthError.conflict('auth.already_initialized', 'Account already initialized')
      }
      const setupToken = body.setupToken?.trim()
      if (!setupToken || !deps.validateSetupToken(setupToken)) {
        throw new AuthError('auth.invalid_setup_token', 'Invalid or expired setup token', 401, {
          code: 'auth.invalid_setup_token'
        })
      }
    }
    const data = await auth.setup(body.username ?? '', body.password ?? '')
    deps.clearSetupGate()
    issue(c, deps, data)
    return c.json(deps.ok(responsePayload(c, data), requestId(c)))
  })

  routes.post('/login', async (c) => {
    const body = await parseAuthBody<Static<typeof LoginBodySchema>>(c, LoginBodySchema)
    const options: LoginOptions = {
      username: body.username ?? '',
      password: body.password ?? '',
      clientIp: deps.getClientIp(c),
      ...(body.captchaId ? { captchaId: body.captchaId } : {}),
      ...(body.captchaAnswer ? { captchaAnswer: body.captchaAnswer } : {})
    }
    const data = await auth.login(options)
    issue(c, deps, data)
    return c.json(deps.ok(responsePayload(c, data), requestId(c)))
  })

  routes.post('/logout', (c) => {
    const credential = readSessionCredential(c)
    const principal = credential.token ? auth.authenticateToken(credential.token) : null
    auth.logout(credential.token)
    if (principal) {
      deps.onSessionRevoked?.({
        userId: principal.userId,
        sessionId: principal.sessionId,
        scope: 'session'
      })
    }
    clearSessionCookies(c)
    return c.json(deps.ok({ loggedOut: true }, requestId(c)))
  })

  routes.post('/logout-all', (c) => {
    const principal = requireAuthPrincipal()
    auth.logoutAll(principal)
    deps.onSessionRevoked?.({ userId: principal.userId, scope: 'user' })
    clearSessionCookies(c)
    return c.json(deps.ok({ loggedOut: true }, requestId(c)))
  })

  routes.post('/change-password', async (c) => {
    const principal = requireAuthPrincipal()
    const body = await parseAuthBody<Static<typeof ChangePasswordBodySchema>>(
      c,
      ChangePasswordBodySchema
    )
    const data = await auth.changePassword(
      principal,
      body.currentPassword ?? '',
      body.newPassword ?? ''
    )
    deps.onSessionRevoked?.({ userId: principal.userId, scope: 'user' })
    issue(c, deps, data)
    return c.json(deps.ok(responsePayload(c, data), requestId(c)))
  })

  routes.post('/captcha', (c) => {
    return c.json(deps.ok(auth.generateCaptcha(deps.getClientIp(c)), requestId(c)))
  })

  return routes
}
