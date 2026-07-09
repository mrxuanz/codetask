import { Hono } from 'hono'
import type { AppContext } from '../context'
import { ok } from '../response'
import {
  getBootstrap,
  loginAccount,
  logoutAccount,
  setupAccount,
  type LoginOptions
} from '../auth/service'
import { validateSetupToken } from '../auth/setup-token'
import { getClientIp, scopeKeyForLogin, hashIp, bucketKeyForIp } from '../auth/client-ip'
import { generateCaptcha } from '../auth/captcha'
import { rateLimit, CAPTCHA_GEN_RULE } from '../auth/memory-limiter'

function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader?.startsWith('Bearer ')) return undefined
  const token = authHeader.slice(7).trim()
  return token || undefined
}

export function createAuthRoutes(ctx: AppContext): Hono {
  const auth = new Hono()

  auth.get('/bootstrap', async (c) => {
    const token = bearerToken(c.req.header('Authorization'))
    const data = await getBootstrap(token)
    return c.json(
      ok({
        ...data,
        setupTokenRequired: ctx.security.mode === 'server' && !data.initialized
      })
    )
  })

  auth.post('/setup', async (c) => {
    const precheck = await getBootstrap()
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

      const body = await c.req.json<{ username?: string; password?: string; setupToken?: string }>()
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
      const data = await setupAccount(body.username ?? '', body.password ?? '')
      return c.json(ok(data))
    }

    const body = await c.req.json<{ username?: string; password?: string }>()
    const data = await setupAccount(body.username ?? '', body.password ?? '')
    return c.json(ok(data))
  })

  auth.post('/login', async (c) => {
    const body = await c.req.json<{
      username?: string
      password?: string
      captchaId?: string
      captchaAnswer?: string
    }>()
    const clientIp = getClientIp(c)
    const opts: LoginOptions = {
      username: body.username ?? '',
      password: body.password ?? '',
      captchaId: body.captchaId,
      captchaAnswer: body.captchaAnswer,
      clientIp,
      authSecret: ctx.security.authSecret
    }
    const data = await loginAccount(opts)
    return c.json(ok(data))
  })

  auth.post('/logout', async (c) => {
    const token = bearerToken(c.req.header('Authorization'))
    await logoutAccount(token)
    return c.json(ok({ loggedOut: true }))
  })

  auth.post('/captcha', async (c) => {
    const clientIp = getClientIp(c)
    const ipHash = hashIp(ctx.security.authSecret, clientIp)
    const bucketKey = bucketKeyForIp(ipHash) + ':capgen'

    const limit = rateLimit(bucketKey, CAPTCHA_GEN_RULE)
    if (!limit.allowed) {
      return c.json(
        {
          data: null,
          status: 40101,
          extra: {},
          message: 'Too many captcha requests',
          success: false
        },
        429
      )
    }

    const result = await generateCaptcha(ctx.security.authSecret, scopeKeyForLogin(ipHash))

    if ('error' in result) {
      return c.json(
        {
          data: null,
          status: 40101,
          extra: {},
          message: result.error,
          success: false
        },
        429
      )
    }

    return c.json(ok(result))
  })

  return auth
}
