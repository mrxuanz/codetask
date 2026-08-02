import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { AuthError } from '@codetask/server-core/modules/auth'
import type { AppContext } from '../context'
import { ok } from '../response'
import { clearProcessSetupGate, validateSetupTokenWithGate } from '../auth/setup-token'
import { getClientIp } from '../auth/client-ip'
import { authErrorToAppError } from '../auth/service'
import { toErrorHttpResult } from '../error'
import { closeRealtimeForSession, closeRealtimeForUser } from '../events/realtime-session-registry'

/**
 * Auth routes at `/api/auth/*` (04 cutover — no root-path dual mount).
 */
export function createAuthRoutes(ctx: AppContext) {
  return ctx.security.auth.module.createRoutes({
    mode: ctx.security.mode,
    getClientIp,
    validateSetupToken: (token) => validateSetupTokenWithGate(ctx.security.authSecret, token),
    clearSetupGate: clearProcessSetupGate,
    ok,
    onSessionRevoked(input) {
      if (input.scope === 'session' && input.userId && input.sessionId) {
        closeRealtimeForSession(input.userId, input.sessionId)
      } else if (input.scope === 'user' && input.userId) {
        closeRealtimeForUser(input.userId)
      }
    },
    onAuthError(error, c) {
      if (error instanceof AuthError) {
        const appErr = authErrorToAppError(error)
        const { body, status } = toErrorHttpResult(appErr)
        return c.json(body, status as ContentfulStatusCode)
      }
      const { body, status } = toErrorHttpResult(error)
      return c.json(body, status as ContentfulStatusCode)
    }
  })
}

export type { Context }
