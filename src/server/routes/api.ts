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
import { createAttachmentRoutes } from './attachments'
import { createFsRoutes } from './fs'
import { createMcpRoutes } from './mcp'
import { createProjectRoutes } from './projects'
import { createSettingsRoutes } from './settings'
import { createSystemRoutes } from './system'
import { createRealtimeRoutes } from './realtime'
import type { ConversationModule, DesignModule, Actor } from '@codetask/server-core'
import {
  currentAuthPrincipal,
  toModuleActor,
  principalToActor
} from '@codetask/server-core/modules/auth'
import {
  getOrComposeConversation,
  getOrComposeExecution,
  type ExecutionModule
} from '../design-module'
import { AppError } from '../error'

function moduleActorFromPrincipal(): Actor | undefined {
  const principal = currentAuthPrincipal()
  if (!principal) return undefined
  return toModuleActor(principalToActor(principal))
}

function executionActorMiddleware() {
  return async (
    c: {
      set: (key: never, value: unknown) => void
    },
    next: () => Promise<void>
  ) => {
    const actor = moduleActorFromPrincipal()
    if (actor) {
      c.set('actor' as never, actor)
    }
    c.set('requestId' as never, crypto.randomUUID())
    await next()
  }
}

function conversationActorMiddleware() {
  return async (
    c: {
      set: (key: never, value: unknown) => void
    },
    next: () => Promise<void>
  ) => {
    const actor = moduleActorFromPrincipal()
    if (actor) {
      c.set('actor' as never, actor)
    }
    c.set('requestId' as never, crypto.randomUUID())
    await next()
  }
}

function designActorMiddleware() {
  return async (
    c: {
      set: (key: never, value: unknown) => void
    },
    next: () => Promise<void>
  ) => {
    const actor = moduleActorFromPrincipal()
    if (actor) {
      c.set('actor' as never, actor)
    }
    await next()
  }
}

/** Gone stub for removed /api/threads surface (03/06 — no forwarding or alias layer). */
function createRemovedThreadsStub(): Hono {
  const routes = new Hono()
  const gone = () => {
    throw AppError.gone(
      'Thread APIs removed; use /api/conversations, /api/drafts, /api/planning-sessions, and /api/jobs',
      'conversation.moved'
    )
  }
  routes.all('/*', gone)
  routes.all('/', gone)
  return routes
}

export function createApiRoutes(
  ctx: AppContext,
  design?: DesignModule,
  execution?: ExecutionModule,
  conversation?: ConversationModule
): Hono {
  const api = new Hono()
  const exec = execution ?? getOrComposeExecution(ctx)
  const conv = conversation ?? getOrComposeConversation(ctx)

  // MCP uses its own protocol auth boundary (localhost + capability tokens) — not session Auth.
  api.route('/mcp', createMcpRoutes(ctx))

  const secured = new Hono()
  secured.use('*', requireAuth(ctx.security))
  secured.use('*', requestGuard(ctx.security))
  secured.use('*', requestTimeout(ctx.config.http.requestTimeoutMs))
  secured.use('*', bodySizeLimit())

  if (design) {
    const designActor = designActorMiddleware()
    secured.use('/drafts/*', designActor)
    secured.use('/planning-sessions/*', designActor)
    secured.use('/drafts', designActor)
    secured.use('/planning-sessions', designActor)
    secured.route('/', design.routes)
  }

  secured.get('/health', (c) => {
    return c.json(ok({ status: 'ok' }))
  })

  secured.route('/system', createSystemRoutes(ctx))
  secured.route('/realtime', createRealtimeRoutes(ctx))

  secured.route('/auth', createAuthRoutes(ctx))
  secured.route('/fs', createFsRoutes(ctx))
  secured.route('/settings', createSettingsRoutes(ctx))
  secured.route('/projects', createProjectRoutes(ctx))

  const convActor = conversationActorMiddleware()
  secured.use('/conversations', convActor)
  secured.use('/conversations/*', convActor)
  secured.use('/projects/:projectId/conversations', convActor)
  secured.use('/projects/:projectId/conversations/*', convActor)
  secured.route('/', conv.routes)
  secured.route('/', createAttachmentRoutes(ctx))

  secured.route('/threads', createRemovedThreadsStub())

  const actorMw = executionActorMiddleware()
  secured.use('/jobs', actorMw)
  secured.use('/jobs/*', actorMw)
  secured.use('/execution-queue', actorMw)
  secured.use('/execution-queue/*', actorMw)
  secured.route('/', exec.routes)

  secured.onError((error, c) => {
    console.error('[api] unhandled error:', error)
    const { body, status } = toErrorHttpResult(error)
    return c.json(body, status as ContentfulStatusCode)
  })

  secured.notFound((c) => {
    return c.json(fail(code.NOT_FOUND, 'Not Found', { error: 'Not Found' }), 404)
  })

  api.route('/', secured)
  return api
}
