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
import { createTurnRoutes } from './turns'
import { createChangeSetRoutes, createProjectChangeSetRoutes } from './change-sets'
import { isV3Authoritative } from '../application/cutover-state'
import { mountV3Routes } from '../http/v3/mount'
import { isStorageMigrationActive } from '../storage/migration'

export function createApiRoutes(ctx: AppContext): Hono {
  const api = new Hono()

  api.use('*', requireAuth())
  api.use('*', requestGuard(ctx.security))
  api.use('*', requestTimeout(ctx.config.http.requestTimeoutMs))
  api.use('*', bodySizeLimit())
  api.use('*', async (c, next) => {
    if (
      isStorageMigrationActive() &&
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      !c.req.path.includes('/settings/storage/migrations')
    ) {
      return c.json(
        fail(50301, 'storage_migration_in_progress', { error: 'storage_migration_in_progress' }),
        503
      )
    }
    return next()
  })

  api.get('/health', (c) => {
    return c.json(ok({ status: 'ok' }))
  })

  api.route('/system', createSystemRoutes(ctx))
  api.route('/events', createEventsRoutes(ctx))
  // Canonical realtime gateway (same hub as /events; prefer this path going forward).
  api.route('/realtime', createEventsRoutes(ctx))

  api.route('/', createAuthRoutes(ctx))
  api.route('/fs', createFsRoutes(ctx))
  api.route('/settings', createSettingsRoutes(ctx))
  api.route('/mcp', createMcpRoutes(ctx))
  api.route('/projects', createProjectRoutes(ctx))
  api.route('/projects', createProjectThreadRoutes(ctx))
  api.route('/projects', createProjectChangeSetRoutes(ctx))
  api.route('/change-sets', createChangeSetRoutes(ctx))
  api.route('/agent', createAgentRoutes(ctx))
  api.route('/threads', createThreadRoutes(ctx))
  api.route('/threads', createThreadAgentRoutes(ctx))
  api.route('/threads', createTurnRoutes(ctx))
  api.route('/threads', createAttachmentRoutes(ctx))
  api.route('/threads', createJobRoutes(ctx))
  api.route('/threads', createDesignSessionRoutes(ctx))
  api.route('/jobs', createUserJobRoutes(ctx))
  api.route('/drafts', createDraftListRoutes(ctx))

  // V3 Job API only when process generation is authoritative. Legacy roots must not
  // initialize control-plane services (FIX-PLAN F0/F1).
  if (isV3Authoritative(ctx.db)) {
    api.route('/v3', mountV3Routes(ctx))
  }

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
