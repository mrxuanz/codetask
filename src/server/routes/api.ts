import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppContext } from '../context'
import { code, toErrorHttpResult } from '../error'
import { fail, ok } from '../response'
import { requireAuth } from '../middleware/require-auth'
import { requestGuard } from '../middleware/request-guard'
import { createAuthRoutes } from './auth'
import { createAgentRoutes, createThreadAgentRoutes } from './conversation'
import { createAttachmentRoutes } from './attachments'
import { createFsRoutes } from './fs'
import { createJobRoutes, createUserJobRoutes } from './jobs'
import { createDraftListRoutes } from './drafts'
import { createDesignSessionRoutes } from './design-sessions'
import { createMcpRoutes } from './mcp'
import { createProjectRoutes } from './projects'
import { createSettingsRoutes } from './settings'
import { createSystemRoutes } from './system'
import { createEventsRoutes } from './events'
import { createProjectThreadRoutes, createThreadRoutes } from './threads'

export function createApiRoutes(ctx: AppContext): Hono {
  const api = new Hono()

  api.use('*', requireAuth())
  api.use('*', requestGuard(ctx.security))

  api.get('/health', (c) => {
    return c.json(ok({ status: 'ok' }))
  })

  api.route('/system', createSystemRoutes(ctx))
  api.route('/events', createEventsRoutes(ctx))

  api.route('/', createAuthRoutes(ctx))
  api.route('/fs', createFsRoutes(ctx))
  api.route('/settings', createSettingsRoutes(ctx))
  api.route('/mcp', createMcpRoutes(ctx))
  api.route('/projects', createProjectRoutes(ctx))
  api.route('/projects', createProjectThreadRoutes(ctx))
  api.route('/agent', createAgentRoutes(ctx))
  api.route('/threads', createThreadRoutes(ctx))
  api.route('/threads', createThreadAgentRoutes(ctx))
  api.route('/threads', createAttachmentRoutes(ctx))
  api.route('/threads', createJobRoutes(ctx))
  api.route('/threads', createDesignSessionRoutes(ctx))
  api.route('/jobs', createUserJobRoutes(ctx))
  api.route('/drafts', createDraftListRoutes(ctx))

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
