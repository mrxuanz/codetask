import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppContext } from '../../context'
import type { ActorContext } from '@shared/contracts/control-plane'
import { requireUsername } from '../../auth/session'
import { getControlPlaneServices } from '../../application/control-plane-services'
import { createJobsRoutes, type HttpRequest } from './jobs-routes'
import { fail, ok } from '../../response'
import { code } from '../../error'

function headerRecord(c: {
  req: { header: (name: string) => string | undefined; raw: { headers: Headers } }
}): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  return headers
}

async function toHttpRequest(c: {
  req: {
    param: (key: string) => string
    query: (key: string) => string | undefined
    header: (name: string) => string | undefined
    json: () => Promise<unknown>
    raw: { headers: Headers }
  }
}): Promise<HttpRequest> {
  let body: unknown = undefined
  const contentType = c.req.header('content-type')
  if (contentType?.includes('application/json')) {
    try {
      body = await c.req.json()
    } catch {
      body = undefined
    }
  }

  return {
    headers: headerRecord(c),
    params: { id: c.req.param('id') },
    query:
      c.req.query('projectId') !== undefined
        ? { projectId: c.req.query('projectId') ?? '' }
        : undefined,
    body
  }
}

function toActor(username: string, requestId: string): ActorContext {
  return { username, requestId }
}

function mapRouteError(error: unknown): { status: number; body: ReturnType<typeof fail> } | null {
  if (!(error instanceof Error)) {
    return null
  }

  if (
    error.message.includes('header required') ||
    error.message.includes('Invalid If-Match') ||
    error.message.includes('Invalid Idempotency-Key')
  ) {
    return {
      status: 400,
      body: fail(code.BAD_REQUEST, error.message)
    }
  }

  return null
}

function wrapSuccessBody(body: unknown): unknown {
  if (body !== null && typeof body === 'object' && 'success' in (body as object)) {
    return body
  }
  return ok(body)
}

export function mountV3Routes(ctx: AppContext): Hono {
  const routes = new Hono()
  const services = getControlPlaneServices(ctx)
  const jobs = createJobsRoutes(services.commandService, services.queryService)

  async function invoke(
    c: Parameters<Parameters<Hono['post']>[1]>[0],
    handler: (
      request: HttpRequest,
      actor: ActorContext
    ) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>
  ) {
    try {
      const username = await requireUsername(c.req.header('Authorization'))
      const request = await toHttpRequest(c)
      const actor = toActor(username, c.req.header('x-request-id') ?? crypto.randomUUID())
      const response = await handler(request, actor)
      const headers = response.headers ?? {}
      const payload =
        response.status >= 400
          ? response.body !== null &&
            typeof response.body === 'object' &&
            'success' in (response.body as object)
            ? response.body
            : fail(code.BAD_REQUEST, 'request failed', response.body)
          : wrapSuccessBody(response.body)
      return c.json(payload, response.status as ContentfulStatusCode, headers)
    } catch (error) {
      const mapped = mapRouteError(error)
      if (mapped) {
        return c.json(mapped.body, mapped.status as ContentfulStatusCode)
      }
      throw error
    }
  }

  routes.get('/jobs', (c) => invoke(c, jobs.listJobs))
  routes.get('/jobs/:id', (c) => invoke(c, jobs.getJob))
  routes.post('/jobs/:id/pause', (c) => invoke(c, jobs.pause))
  routes.post('/jobs/:id/continue', (c) => invoke(c, jobs.continue))
  routes.post('/jobs/:id/cancel', (c) => invoke(c, jobs.cancel))
  routes.post('/jobs/:id/restart-execution', (c) => invoke(c, jobs.restartExecution))

  return routes
}
