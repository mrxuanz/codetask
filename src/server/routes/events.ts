import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { AppError } from '../error'
import { ok } from '../response'
import { registerJobHubConnection } from '../events/job-event-hub'
import { getUserJob } from '../jobs/service'

const activeHubs = new Map<string, ReturnType<typeof registerJobHubConnection>>()
const pendingJobIds = new Map<string, string[]>()

export function createEventsRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()

  routes.put('/jobs/subscriptions', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = (await c.req.json()) as { jobIds?: string[] }
    const jobIds = Array.isArray(body.jobIds) ? [...new Set(body.jobIds.map(String))] : []

    for (const jobId of jobIds) {
      const job = await getUserJob(username, jobId)
      if (!job) {
        throw AppError.notFound('Job not found', 'job.not_found', { jobId })
      }
    }

    const hub = activeHubs.get(username)
    if (hub) {
      await hub.setSubscriptions(jobIds)
    } else {
      pendingJobIds.set(username, jobIds)
    }
    return c.json(ok({ jobIds }))
  })

  routes.get('/jobs/stream', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const hub = registerJobHubConnection(username)
    activeHubs.set(username, hub)

    const queued = pendingJobIds.get(username)
    if (queued) {
      pendingJobIds.delete(username)
      await hub.setSubscriptions(queued)
    }

    return streamSSE(c, async (stream) => {
      try {
        for await (const envelope of hub.stream) {
          await stream.writeSSE({
            event: 'job',
            data: JSON.stringify(envelope)
          })
        }
      } finally {
        hub.close()
        activeHubs.delete(username)
      }
    })
  })

  return routes
}
