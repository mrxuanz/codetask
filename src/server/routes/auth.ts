import { Hono } from 'hono'
import type { AppContext } from '../context'
import { ok } from '../response'
import { getClientIp } from '../auth/client-ip'
import {
  clearAuthSessionCookies,
  readAuthSessionCookie,
  setAuthSessionCookies
} from '../interfaces/http/auth-session-cookie'

export function createAuthRoutes(ctx: AppContext): Hono {
  const routes = new Hono()
  const auth = ctx.security.auth

  routes.get('/bootstrap', (c) => {
    const data = auth.service.bootstrap(readAuthSessionCookie(c))
    c.header('Cache-Control', 'no-store')
    return c.json(
      ok({
        ...data,
        setupTokenRequired: ctx.security.mode === 'server' && !data.initialized
      })
    )
  })

  routes.post('/setup', async (c) => {
    const body = await c.req.json<{
      username?: string
      password?: string
      setupToken?: string
    }>()
    const session = await auth.service.setupAccount({
      username: body.username ?? '',
      password: body.password ?? '',
      setupGrant: body.setupToken?.trim(),
      requestScope: getClientIp(c)
    })
    setAuthSessionCookies(c, auth, session)
    return c.json(
      ok({
        username: session.username,
        expires_at: Math.floor(session.expiresAtMs / 1_000)
      })
    )
  })

  routes.post('/login', async (c) => {
    const body = await c.req.json<{
      username?: string
      password?: string
      challengeId?: string
      challengeAnswer?: string
      captchaId?: string
      captchaAnswer?: string
    }>()
    const session = await auth.service.login({
      username: body.username ?? '',
      password: body.password ?? '',
      requestScope: getClientIp(c),
      challengeId: body.challengeId ?? body.captchaId,
      challengeAnswer: body.challengeAnswer ?? body.captchaAnswer
    })
    setAuthSessionCookies(c, auth, session)
    return c.json(
      ok({
        username: session.username,
        expires_at: Math.floor(session.expiresAtMs / 1_000)
      })
    )
  })

  routes.post('/logout', (c) => {
    auth.service.logout(readAuthSessionCookie(c))
    clearAuthSessionCookies(c)
    return c.json(ok({ loggedOut: true }))
  })

  routes.post('/logout-all', (c) => {
    const token = readAuthSessionCookie(c)
    if (token) auth.service.logoutAll(token)
    clearAuthSessionCookies(c)
    return c.json(ok({ loggedOut: true }))
  })

  routes.post('/change-password', async (c) => {
    const token = readAuthSessionCookie(c) ?? ''
    const body = await c.req.json<{
      currentPassword?: string
      newPassword?: string
    }>()
    const session = await auth.service.changePassword({
      token,
      currentPassword: body.currentPassword ?? '',
      newPassword: body.newPassword ?? ''
    })
    setAuthSessionCookies(c, auth, session)
    return c.json(
      ok({
        username: session.username,
        expires_at: Math.floor(session.expiresAtMs / 1_000)
      })
    )
  })

  routes.post('/captcha', (c) => {
    const challenge = auth.service.issueChallenge(getClientIp(c))
    c.header('Cache-Control', 'no-store')
    return c.json(
      ok({
        challengeId: challenge.challengeId,
        image: challenge.publicPayload,
        expires_at: Math.floor(challenge.expiresAtMs / 1_000)
      })
    )
  })

  return routes
}
