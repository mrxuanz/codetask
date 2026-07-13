import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppContext } from '../../context'
import type { ActorContext } from '@shared/contracts/control-plane'
import { requireUsername } from '../../auth/session'
import { getControlPlaneServices } from '../../application/control-plane-services'
import {
  getControlPlaneLatestEventId,
  getControlPlaneReplayEvents,
  subscribeControlPlaneEvents
} from '../../application/control-plane-runtime'
import { createJobsRoutes, type HttpRequest } from './jobs-routes'
import { fail, ok } from '../../response'
import { code } from '../../error'
import { DomainError } from '../../domain/jobs/job-errors'
import { formatSseEvent, formatSseJsonEvent, type SseEnvelope } from './sse-envelope'

const CONTROL_PLANE_REPLAY_LIMIT = 100

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
    query: {
      ...(c.req.query('projectId') !== undefined
        ? { projectId: c.req.query('projectId') ?? '' }
        : {}),
      ...(c.req.query('status') !== undefined ? { status: c.req.query('status') ?? '' } : {}),
      ...(c.req.query('page') !== undefined ? { page: c.req.query('page') ?? '' } : {}),
      ...(c.req.query('limit') !== undefined ? { limit: c.req.query('limit') ?? '' } : {}),
      ...(c.req.query('q') !== undefined ? { q: c.req.query('q') ?? '' } : {})
    },
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

  if (error instanceof DomainError) {
    return {
      status: 409,
      body: fail(code.CONFLICT, error.code, error.details)
    }
  }

  if (error.message === 'job.not_found') {
    return {
      status: 404,
      body: fail(code.NOT_FOUND, error.message)
    }
  }

  if (error.message === 'job.revision_conflict' || error.message === 'idempotency_key_reused') {
    return {
      status: 409,
      body: fail(code.CONFLICT, error.message)
    }
  }

  if (error.message.startsWith('job.')) {
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

function parseLastEventId(header: string | undefined): number {
  if (!header) return 0
  const parsed = Number.parseInt(header, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
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

  routes.get('/events', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const actor = toActor(username, c.req.header('x-request-id') ?? crypto.randomUUID())
    const lastEventId = parseLastEventId(c.req.header('last-event-id'))

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        const connectionId = crypto.randomUUID()
        const liveBuffer: SseEnvelope[] = []
        let replayReady = false
        let closed = false
        let lastSentEventId = lastEventId
        let unsubscribe = () => {}
        let heartbeat: ReturnType<typeof setInterval> | null = null

        const cleanup = () => {
          if (closed) return
          closed = true
          if (heartbeat) {
            clearInterval(heartbeat)
            heartbeat = null
          }
          unsubscribe()
          c.req.raw.signal.removeEventListener('abort', cleanup)
          try {
            controller.close()
          } catch {
            // already closed
          }
        }

        const enqueue = (chunk: string): boolean => {
          try {
            controller.enqueue(encoder.encode(chunk))
            return true
          } catch {
            cleanup()
            return false
          }
        }

        const closeWithResync = (reason: 'cursor_too_old' | 'slow_consumer') => {
          if (closed) return
          enqueue(
            formatSseJsonEvent({
              event: 'resync_required',
              data: {
                reason,
                restartFromEventId: getControlPlaneLatestEventId(ctx, actor)
              }
            })
          )
          cleanup()
        }

        unsubscribe = subscribeControlPlaneEvents(ctx, actor, connectionId, (event) => {
          if (closed) return
          if (!replayReady) {
            liveBuffer.push(event)
            return
          }
          if (event.eventId <= lastSentEventId) {
            return
          }
          if (!enqueue(formatSseEvent(event))) {
            return
          }
          lastSentEventId = event.eventId
          if ((controller.desiredSize ?? 1) < 0) {
            closeWithResync('slow_consumer')
          }
        })

        const initialEvents = getControlPlaneReplayEvents(
          ctx,
          actor,
          lastEventId,
          CONTROL_PLANE_REPLAY_LIMIT + 1
        )
        if (initialEvents.length > CONTROL_PLANE_REPLAY_LIMIT) {
          closeWithResync('cursor_too_old')
          return
        }

        for (const event of initialEvents) {
          if (!enqueue(formatSseEvent(event))) {
            return
          }
          lastSentEventId = event.eventId
          if ((controller.desiredSize ?? 1) < 0) {
            closeWithResync('slow_consumer')
            return
          }
        }

        replayReady = true
        liveBuffer.sort((a, b) => a.eventId - b.eventId)
        for (const event of liveBuffer) {
          if (event.eventId <= lastSentEventId) {
            continue
          }
          if (!enqueue(formatSseEvent(event))) {
            return
          }
          lastSentEventId = event.eventId
          if ((controller.desiredSize ?? 1) < 0) {
            closeWithResync('slow_consumer')
            return
          }
        }
        liveBuffer.length = 0

        heartbeat = setInterval(() => {
          enqueue(': heartbeat\n\n')
        }, 25000)

        c.req.raw.signal.addEventListener('abort', cleanup, { once: true })
      },
      cancel() {
        // cleanup is handled by abort listener / enqueue failure
      }
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    })
  })

  routes.get('/jobs', (c) => invoke(c, jobs.listJobs))
  routes.get('/jobs/:id', (c) => invoke(c, jobs.getJob))
  routes.post('/jobs/:id/pause', (c) => invoke(c, jobs.pause))
  routes.post('/jobs/:id/continue', (c) => invoke(c, jobs.continue))
  routes.post('/jobs/:id/cancel', (c) => invoke(c, jobs.cancel))
  routes.post('/jobs/:id/restart-execution', (c) => invoke(c, jobs.restartExecution))

  return routes
}
