import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppContext } from '../context'
import { code, toErrorHttpResult } from '../error'
import { fail, ok } from '../response'
import { requireAuth } from '../middleware/require-auth'
import { requestGuard } from '../middleware/request-guard'
import { bodySizeLimit } from '../middleware/body-limiter'
import { requestTimeout } from '../middleware/http-limits'
import { createAuthRoutes } from './auth'
import { getSandboxHealth } from '../sandbox/health'
import { createConversationRoutes } from './conversation'
import { createDraftRoutes } from './drafts'

export function createApiRoutes(ctx: AppContext): Hono {
  const api = new Hono()

  api.use('*', requestGuard(ctx.security))
  api.use('*', bodySizeLimit())
  api.use('*', requestTimeout())
  api.use('*', requireAuth(ctx.security.auth))

  api.get('/health', (c) => {
    return c.json(ok({ status: 'ok' }))
  })

  api.route('/', createAuthRoutes(ctx))
  api.route('/', createConversationRoutes(ctx))
  api.route('/', createDraftRoutes(ctx))
  api.get('/sandbox/health', (c) => c.json(ok(getSandboxHealth(ctx.dataDir))))

  api.onError((error, c) => {
    console.error('[api] unhandled error:', error)
    const { body, status } = toErrorHttpResult(error)
    return c.json(body, status as ContentfulStatusCode)
  })

  api.notFound((c) => {
    return c.json(fail(code.NOT_FOUND, 'Not Found', { error: 'Not Found' }), 404)
  })

  return api
}
