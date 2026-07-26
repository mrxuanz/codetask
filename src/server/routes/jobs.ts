import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppContext } from '../context'
import { getRequestAuthPrincipal } from '../auth/session'
import { AppError } from '../error'
import { ok } from '../response'
import { listProviderDescriptors } from '../../shared/providers/descriptors'
import type { JobEventRecord } from '../core/application/ports'
import { defaultJobSettings } from '../core/domain/job'

function userIdFrom(context: Parameters<typeof getRequestAuthPrincipal>[0]): string {
  const principal = getRequestAuthPrincipal(context)
  if (!principal) throw AppError.unauthorized()
  return principal.userId
}

function cursor(value: string | undefined): number {
  const parsed = Number(value ?? '0')
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

export function createJobRoutes(ctx: AppContext): Hono {
  const routes = new Hono()
  const service = ctx.job.service

  routes.get('/job-settings', (c) => {
    return c.json(
      ok({
        settings: service.getSettings(userIdFrom(c)),
        defaults: defaultJobSettings()
      })
    )
  })

  routes.put('/job-settings', async (c) => {
    const body = await c.req.json<{ expectedRevision?: number; settings?: unknown }>()
    if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision ?? -1) < 0) {
      throw AppError.badRequest('job.settings_revision_invalid')
    }
    return c.json(
      ok({
        settings: service.updateSettings(
          userIdFrom(c),
          body.settings,
          body.expectedRevision as number
        ),
        defaults: defaultJobSettings()
      })
    )
  })

  routes.get('/job-providers', (c) => {
    userIdFrom(c)
    return c.json(
      ok(
        listProviderDescriptors().map((descriptor) => ({
          code: descriptor.code,
          label: descriptor.label,
          protocol: descriptor.capabilities.protocol,
          supportsTask: descriptor.capabilities.supportedProfiles.includes('task-sandbox'),
          supportsVerification:
            descriptor.capabilities.supportedProfiles.includes('verifier-sandbox')
        }))
      )
    )
  })

  routes.get('/jobs', (c) => c.json(ok(service.listJobs(userIdFrom(c)))))

  routes.get('/jobs/:jobId', (c) => {
    return c.json(ok(service.getJob(userIdFrom(c), c.req.param('jobId'))))
  })

  routes.post('/jobs/:jobId/pause', (c) => {
    return c.json(ok(ctx.job.pause(userIdFrom(c), c.req.param('jobId'))))
  })

  routes.post('/jobs/:jobId/continue', (c) => {
    return c.json(ok(ctx.job.continue(userIdFrom(c), c.req.param('jobId'))))
  })

  routes.delete('/jobs/:jobId', async (c) => {
    await ctx.job.delete(userIdFrom(c), c.req.param('jobId'))
    return c.json(ok({ deleted: true }))
  })

  routes.get('/job-events', (c) => {
    const userId = userIdFrom(c)
    const initialCursor = cursor(c.req.query('after') ?? c.req.header('Last-Event-ID') ?? undefined)
    return streamSSE(c, async (stream) => {
      let lastId = initialCursor
      let writes = Promise.resolve()
      const send = (event: JobEventRecord): void => {
        if (event.userId !== userId || event.id <= lastId) return
        lastId = event.id
        writes = writes.then(() =>
          stream.writeSSE({
            id: String(event.id),
            event: 'job',
            data: JSON.stringify({
              jobId: event.jobId,
              eventType: event.eventType,
              payload: JSON.parse(event.payloadJson),
              createdAtMs: event.createdAtMs
            })
          })
        )
      }
      for (const event of service.listEvents(userId, initialCursor)) send(event)
      const unsubscribe = service.subscribe(send)
      const heartbeat = setInterval(() => {
        writes = writes.then(() =>
          stream.writeSSE({
            event: 'heartbeat',
            data: JSON.stringify({ nowMs: Date.now() })
          })
        )
      }, 15_000)
      heartbeat.unref()
      try {
        await new Promise<void>((resolve) => {
          if (c.req.raw.signal.aborted) resolve()
          else c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        await writes
      } finally {
        clearInterval(heartbeat)
        unsubscribe()
      }
    })
  })

  return routes
}
