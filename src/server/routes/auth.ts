import { Hono, type Context } from 'hono'
import type { AppContext } from '../context'
import { ok } from '../response'
import type { AuthData, LoginOptions } from '../auth/service'
import { validateSetupToken } from '../auth/setup-token'
import { getClientIp } from '../auth/client-ip'
import {
  clearSessionCookies,
  issueSessionCookies,
  readSessionCredential
} from '../auth/http-session'
import { requireAuthPrincipal } from '../auth/session'

function responseData(c: Context, data: AuthData): Omit<AuthData, 'token'> | AuthData {
  if (c.req.header('x-codetask-auth-transport')?.toLowerCase() === 'bearer') {
    return data
  }
  const { token: _token, ...browserData } = data
  return browserData
}

function issue(c: Context, ctx: AppContext, data: AuthData): void {
  issueSessionCookies(c, {
    token: data.token,
    expiresAtSec: data.expires_at,
    authSecret: ctx.security.authSecret
  })
}

export function createAuthRoutes(ctx: AppContext): Hono {
  const routes = new Hono()
  const auth = ctx.security.auth

  routes.get('/bootstrap', async (c) => {
    const credential = readSessionCredential(c)
    const data = await auth.bootstrap(credential.token)
    return c.json(
      ok({
        ...data,
        setupTokenRequired: ctx.security.mode === 'server' && !data.initialized
      })
    )
  })

  routes.post('/setup', async (c) => {
    const precheck = await auth.bootstrap()
    const body = await c.req.json<{
      username?: string
      password?: string
      setupToken?: string
    }>()
    if (ctx.security.mode === 'server') {
      if (precheck.initialized) {
        return c.json(
          {
            data: null,
            status: 40901,
            extra: {},
            message: 'Account already initialized',
            success: false
          },
          409
        )
      }
      const setupToken = body.setupToken?.trim()
      if (!setupToken || !validateSetupToken(ctx.security.authSecret, setupToken)) {
        return c.json(
          {
            data: null,
            status: 40101,
            extra: {},
            message: 'Invalid or expired setup token',
            success: false
          },
          401
        )
      }
    }
    const data = await auth.setup(body.username ?? '', body.password ?? '')
    issue(c, ctx, data)
    return c.json(ok(responseData(c, data)))
  })

  routes.post('/login', async (c) => {
    const body = await c.req.json<{
      username?: string
      password?: string
      captchaId?: string
      captchaAnswer?: string
    }>()
    const options: LoginOptions = {
      username: body.username ?? '',
      password: body.password ?? '',
      clientIp: getClientIp(c),
      ...(body.captchaId ? { captchaId: body.captchaId } : {}),
      ...(body.captchaAnswer ? { captchaAnswer: body.captchaAnswer } : {})
    }
    const data = await auth.login(options)
    issue(c, ctx, data)
    return c.json(ok(responseData(c, data)))
  })

  routes.post('/logout', (c) => {
    auth.logout(readSessionCredential(c).token)
    clearSessionCookies(c)
    return c.json(ok({ loggedOut: true }))
  })

  routes.post('/logout-all', (c) => {
    auth.logoutAll(requireAuthPrincipal())
    clearSessionCookies(c)
    return c.json(ok({ loggedOut: true }))
  })

  routes.post('/change-password', async (c) => {
    const body = await c.req.json<{ currentPassword?: string; newPassword?: string }>()
    const data = await auth.changePassword(
      requireAuthPrincipal(),
      body.currentPassword ?? '',
      body.newPassword ?? ''
    )
    issue(c, ctx, data)
    return c.json(ok(responseData(c, data)))
  })

  routes.post('/captcha', (c) => {
    return c.json(ok(auth.generateCaptcha(getClientIp(c))))
  })

  return routes
}
