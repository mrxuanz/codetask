import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Context } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { AppError } from '../error'
import { ok } from '../response'
import { registerJobHubConnection } from '../events/job-event-hub'
import { getUserJob } from '../legacy-control-plane/service'
import { getThread } from '../threads/service'
import { assertSseClientCapacity } from '../middleware/http-limits'
import {
  jobIdFromTopic,
  parseHubTopic,
  threadIdFromTopic,
  type HubTopic
} from '@shared/contracts/job-event-hub'

type HubHandle = ReturnType<typeof registerJobHubConnection>

/** username::connectionId → hub handle (multi-window safe) */
const activeHubs = new Map<string, HubHandle>()
/** username::connectionId → topics queued before stream opens */
const pendingTopics = new Map<string, HubTopic[]>()

function hubKey(username: string, connectionId: string): string {
  return `${username}::${connectionId}`
}

async function assertTopicsOwned(username: string, topics: HubTopic[]): Promise<void> {
  for (const topic of topics) {
    const jobId = jobIdFromTopic(topic)
    if (jobId) {
      if (jobId === 'resync') continue
      const job = await getUserJob(username, jobId)
      if (!job) {
        throw AppError.notFound('Job not found', 'job.not_found', { jobId })
      }
      continue
    }
    const threadId = threadIdFromTopic(topic)
    if (threadId) {
      const thread = await getThread(username, threadId)
      if (!thread) {
        throw AppError.notFound('Thread not found', 'thread.not_found', { threadId })
      }
    }
  }
}

function parseTopicsFromBody(body: {
  topics?: string[]
  jobIds?: string[]
}): HubTopic[] {
  if (Array.isArray(body.topics)) {
    const topics: HubTopic[] = []
    for (const raw of body.topics) {
      const parsed = parseHubTopic(String(raw))
      if (!parsed) {
        throw AppError.badRequest(`Invalid topic: ${raw}`, 'events.invalid_topic')
      }
      topics.push(parsed)
    }
    return [...new Set(topics)]
  }
  if (Array.isArray(body.jobIds)) {
    return [...new Set(body.jobIds.map((id) => `job:${String(id)}` as HubTopic))]
  }
  return []
}

async function handleSubscriptions(c: Context): Promise<Response> {
  const username = await requireUsername(c.req.header('Authorization'))
  const body = (await c.req.json()) as {
    connectionId?: string
    topics?: string[]
    jobIds?: string[]
  }
  const connectionId =
    (typeof body.connectionId === 'string' && body.connectionId.trim()) ||
    c.req.header('x-hub-connection-id')?.trim() ||
    ''
  if (!connectionId) {
    throw AppError.badRequest('connectionId is required', 'events.connection_id_required')
  }

  const topics = parseTopicsFromBody(body)
  await assertTopicsOwned(username, topics)

  const key = hubKey(username, connectionId)
  const hub = activeHubs.get(key)
  if (hub) {
    await hub.setSubscriptions(topics)
  } else {
    pendingTopics.set(key, topics)
  }
  return c.json(ok({ connectionId, topics }))
}

async function handleStream(c: Context): Promise<Response> {
  const username = await requireUsername(c.req.header('Authorization'))
  const connectionId =
    c.req.query('connectionId')?.trim() ||
    c.req.header('x-hub-connection-id')?.trim() ||
    `conn-${Math.random().toString(36).slice(2, 10)}`
  const lastRaw = c.req.header('Last-Event-ID') ?? c.req.query('lastEventId')
  const parsedLast = lastRaw ? Number.parseInt(lastRaw, 10) : NaN
  const lastEventId = Number.isFinite(parsedLast) ? parsedLast : null

  assertSseClientCapacity(activeHubs.keys(), username)

  const hub = registerJobHubConnection(username, connectionId, { lastEventId })
  const key = hubKey(username, hub.connectionId)
  activeHubs.set(key, hub)

  const queued = pendingTopics.get(key)
  if (queued) {
    pendingTopics.delete(key)
    await hub.setSubscriptions(queued)
  }

  return streamSSE(c, async (stream) => {
    try {
      for await (const envelope of hub.stream) {
        await stream.writeSSE({
          id: String(envelope.seq),
          event: 'hub',
          data: JSON.stringify(envelope)
        })
      }
    } finally {
      hub.close()
      activeHubs.delete(key)
    }
  })
}

export function createEventsRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()

  routes.put('/subscriptions', (c) => handleSubscriptions(c))
  routes.put('/jobs/subscriptions', (c) => handleSubscriptions(c))
  routes.get('/stream', (c) => handleStream(c))
  routes.get('/jobs/stream', (c) => handleStream(c))

  return routes
}
