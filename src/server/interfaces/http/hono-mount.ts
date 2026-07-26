/**
 * Hono adapters for new-core HTTP routes.
 *
 * Mirrors `composition/createHttpServer` wiring without importing composition
 * (import-boundary: interfaces must not depend on composition).
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApplicationDependencies } from '../../core/application/dependencies'
import {
  type HttpRequest,
  type HttpResult
} from './route-handler'
import { createConversationRoutes } from './routes/conversation'
import { createDraftRoutes } from './routes/drafts'
import { createPlanRoutes } from './routes/plans'
import { createJobRoutes } from './routes/jobs'

/**
 * Deps required to wire new-core HTTP interface routes.
 * Same pick as composition `HttpServerDeps`, plus optional kernel kind for /health.
 */
export type HttpServerDeps = Pick<
  ApplicationDependencies,
  'threads' | 'drafts' | 'plans' | 'jobs' | 'unitOfWork' | 'idempotency' | 'ids'
> & {
  readonly kind?: 'memory' | 'sqlite'
}

export async function toHttpRequest(
  c: Context,
  params?: Record<string, string>
): Promise<HttpRequest> {
  const headers: Record<string, string | undefined> = {}
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  const query: Record<string, string | undefined> = {}
  const url = new URL(c.req.url)
  url.searchParams.forEach((value, key) => {
    query[key] = value
  })

  const routeParams = params ?? (c.req.param() as Record<string, string>)

  let body: unknown
  const method = c.req.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const contentType = headers['content-type'] ?? ''
    if (contentType.includes('application/json')) {
      try {
        body = await c.req.json()
      } catch {
        body = undefined
      }
    }
  }

  return {
    method: c.req.method,
    path: c.req.path,
    headers,
    params: routeParams,
    query,
    body
  }
}

export function sendHttpResult(c: Context, result: HttpResult<unknown>) {
  if (result.headers) {
    for (const [key, value] of Object.entries(result.headers)) {
      c.header(key, value)
    }
  }
  return c.json(result.body, result.httpStatus as ContentfulStatusCode)
}

function createCoreRoutes(deps: HttpServerDeps) {
  return {
    conversation: createConversationRoutes({ threads: deps.threads }),
    drafts: createDraftRoutes({
      drafts: deps.drafts,
      unitOfWork: deps.unitOfWork,
      idempotency: deps.idempotency,
      jobs: deps.jobs,
      plans: deps.plans,
      ids: deps.ids
    }),
    plans: createPlanRoutes({
      plans: deps.plans,
      unitOfWork: deps.unitOfWork,
      idempotency: deps.idempotency,
      ids: deps.ids
    }),
    jobs: createJobRoutes({
      jobs: deps.jobs,
      unitOfWork: deps.unitOfWork,
      idempotency: deps.idempotency
    })
  }
}

/**
 * Mount new-core HTTP handlers on a Hono app (parallel to legacy `/api` routes).
 * Parent `/api` already applies `requireAuth`; `/health` stays a simple ok.
 */
export function mountCoreHttpRoutes(deps: HttpServerDeps): Hono {
  const app = new Hono()
  const routes = createCoreRoutes(deps)

  app.get('/health', (c) => {
    const data: { kernel: string; kind?: 'memory' | 'sqlite' } = {
      kernel: 'new-core'
    }
    if (deps.kind) data.kind = deps.kind
    return c.json({ success: true, data })
  })

  app.get('/jobs/:jobId', async (c) => {
    const request = await toHttpRequest(c, { jobId: c.req.param('jobId') })
    return sendHttpResult(c, await routes.jobs.getJob(request))
  })

  app.post('/jobs/:jobId/pause', async (c) => {
    const request = await toHttpRequest(c, { jobId: c.req.param('jobId') })
    return sendHttpResult(c, await routes.jobs.pause(request))
  })

  app.post('/jobs/:jobId/continue', async (c) => {
    const request = await toHttpRequest(c, { jobId: c.req.param('jobId') })
    return sendHttpResult(c, await routes.jobs.continue(request))
  })

  app.post('/jobs/:jobId/cancel', async (c) => {
    const request = await toHttpRequest(c, { jobId: c.req.param('jobId') })
    return sendHttpResult(c, await routes.jobs.cancel(request))
  })

  app.post('/jobs/:jobId/retry', async (c) => {
    const request = await toHttpRequest(c, { jobId: c.req.param('jobId') })
    return sendHttpResult(c, await routes.jobs.retry(request))
  })

  app.get('/drafts/:draftId', async (c) => {
    const request = await toHttpRequest(c, { draftId: c.req.param('draftId') })
    return sendHttpResult(c, await routes.drafts.getDraft(request))
  })

  app.post('/drafts/:draftId/confirm', async (c) => {
    const request = await toHttpRequest(c, { draftId: c.req.param('draftId') })
    return sendHttpResult(c, await routes.drafts.confirmDraft(request))
  })

  app.patch('/drafts/:draftId/patch', async (c) => {
    const request = await toHttpRequest(c, { draftId: c.req.param('draftId') })
    return sendHttpResult(c, await routes.drafts.patchDraft(request))
  })

  app.post('/drafts/:draftId/sections/:section/confirm', async (c) => {
    const request = await toHttpRequest(c, {
      draftId: c.req.param('draftId'),
      section: c.req.param('section')
    })
    return sendHttpResult(c, await routes.drafts.confirmDraftSection(request))
  })

  app.post('/drafts/:draftId/unlock', async (c) => {
    const request = await toHttpRequest(c, { draftId: c.req.param('draftId') })
    return sendHttpResult(c, await routes.drafts.unlockDraft(request))
  })

  app.post('/drafts/:draftId/confirm-final', async (c) => {
    const request = await toHttpRequest(c, { draftId: c.req.param('draftId') })
    return sendHttpResult(c, await routes.drafts.confirmDraftFinal(request))
  })

  app.get('/threads/:threadId/agent', async (c) => {
    const request = await toHttpRequest(c, { threadId: c.req.param('threadId') })
    return sendHttpResult(c, await routes.conversation.getThreadAgent(request))
  })

  app.get('/plans/:planId', async (c) => {
    const request = await toHttpRequest(c, { planId: c.req.param('planId') })
    return sendHttpResult(c, await routes.plans.getPlan(request))
  })

  app.post('/plans', async (c) => {
    const request = await toHttpRequest(c)
    return sendHttpResult(c, await routes.plans.createPlan(request))
  })

  app.post('/plans/:planId/confirm', async (c) => {
    const request = await toHttpRequest(c, { planId: c.req.param('planId') })
    return sendHttpResult(c, await routes.plans.confirmPlan(request))
  })

  return app
}
