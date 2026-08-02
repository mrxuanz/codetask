import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Context } from 'hono'
import {
  MAX_REALTIME_TOPICS_PER_CONNECTION,
  REALTIME_CONNECTION_ID_HEADER,
  parseRealtimeTopic,
  conversationIdFromRealtimeTopic,
  jobIdFromRealtimeTopic,
  planningSessionIdFromRealtimeTopic,
  turnIdFromRealtimeTopic,
  type RealtimeTopic
} from '@codetask/contracts'
import { requireAuthPrincipal, type AuthPrincipal } from '@codetask/server-core/modules/auth'
import type { AppContext } from '../context'
import { AppError } from '../error'
import { ok } from '../response'
import { assertSseClientCapacity } from '../middleware/http-limits'
import { getOwnedRealtimeJob } from '../events/realtime-job-ownership'
import {
  activeRealtimeKeys,
  bindRealtimeHandle,
  getRealtimeHandle,
  queuePendingTopics,
  realtimeKey,
  takePendingTopics,
  unbindRealtimeHandle,
  type RealtimeStreamHandle
} from '../events/realtime-session-registry'

const SESSION_RECHECK_MS = 60_000
const CONNECTION_ID_HEADER = REALTIME_CONNECTION_ID_HEADER.toLowerCase()

function readConnectionId(c: Context, fromBody?: unknown): string {
  const header = c.req.header(CONNECTION_ID_HEADER)?.trim() ?? ''
  if (header) return header
  // Body connectionId is rejected — protocol requires header only.
  void fromBody
  return ''
}

async function assertTopicsOwned(actorId: string, topics: RealtimeTopic[]): Promise<void> {
  for (const topic of topics) {
    if (topic === 'settings:self') continue

    const jobId = jobIdFromRealtimeTopic(topic)
    if (jobId) {
      const job = await getOwnedRealtimeJob(actorId, jobId)
      if (!job) {
        throw AppError.notFound('Job not found', 'job.not_found', { jobId })
      }
      continue
    }

    const turnId = turnIdFromRealtimeTopic(topic)
    if (turnId) {
      const { getDb } = await import('../db')
      const client = (getDb() as { $client?: import('better-sqlite3').Database }).$client
      const row = client
        ?.prepare(`SELECT actor_id FROM conversation_turns WHERE id = ?`)
        .get(turnId) as { actor_id: string } | undefined
      if (!row || row.actor_id !== actorId) {
        throw AppError.notFound('Turn not found', 'turn.not_found', { turnId })
      }
      continue
    }

    const conversationId = conversationIdFromRealtimeTopic(topic)
    if (conversationId) {
      const { getOrComposeConversation } = await import('../design-module')
      const { getAppContext } = await import('../bootstrap')
      try {
        getOrComposeConversation(getAppContext()).app.get(
          { userId: actorId, sessionId: 'realtime' },
          conversationId
        )
      } catch {
        throw AppError.notFound('Conversation not found', 'conversation.not_found', {
          conversationId
        })
      }
      continue
    }

    const sessionId = planningSessionIdFromRealtimeTopic(topic)
    if (sessionId) {
      const { getDb } = await import('../db')
      const client = (getDb() as { $client?: import('better-sqlite3').Database }).$client
      if (!client) throw AppError.internal('SQLite client missing')
      const row = client
        .prepare(`SELECT actor_id FROM planning_sessions WHERE id = ?`)
        .get(sessionId) as { actor_id: string } | undefined
      if (!row || row.actor_id !== actorId) {
        throw AppError.notFound('Planning session not found', 'planning.not_found', { sessionId })
      }
    }
  }
}

function parseTopicsFromBody(body: { topics?: unknown }): RealtimeTopic[] {
  if (!Array.isArray(body.topics)) {
    throw AppError.badRequest('topics array is required', 'events.invalid_topic')
  }
  if (body.topics.length > MAX_REALTIME_TOPICS_PER_CONNECTION) {
    throw AppError.badRequest(
      `At most ${MAX_REALTIME_TOPICS_PER_CONNECTION} topics allowed`,
      'events.topic_limit'
    )
  }
  const topics: RealtimeTopic[] = []
  for (const raw of body.topics) {
    const parsed = parseRealtimeTopic(String(raw))
    if (!parsed) {
      throw AppError.badRequest(`Invalid topic: ${raw}`, 'events.invalid_topic')
    }
    topics.push(parsed)
  }
  return [...new Set(topics)]
}

async function handleSubscriptions(c: Context): Promise<Response> {
  const principal = requireAuthPrincipal()
  const body = (await c.req.json()) as { topics?: unknown; connectionId?: unknown }
  const connectionId = readConnectionId(c, body)
  if (!connectionId) {
    throw AppError.badRequest(
      `${REALTIME_CONNECTION_ID_HEADER} header is required`,
      'events.connection_id_required'
    )
  }
  if (body.connectionId !== undefined) {
    throw AppError.badRequest(
      'connectionId must be sent via header only',
      'events.connection_id_header_only'
    )
  }

  const topics = parseTopicsFromBody(body)
  await assertTopicsOwned(principal.userId, topics)

  const key = realtimeKey(principal.userId, principal.sessionId, connectionId)
  const handle = getRealtimeHandle(key)
  if (handle) {
    handle.setSubscriptions(topics)
  } else {
    queuePendingTopics(key, topics)
  }
  return c.json(ok({ connectionId, topics }))
}

async function handleStream(c: Context, ctx: AppContext): Promise<Response> {
  const principal = requireAuthPrincipal()
  const maxClientsPerUser = ctx.config.http.maxSseClientsPerUser
  const connectionId = readConnectionId(c)
  if (!connectionId) {
    throw AppError.badRequest(
      `${REALTIME_CONNECTION_ID_HEADER} header is required`,
      'events.connection_id_required'
    )
  }
  if (c.req.query('connectionId')) {
    throw AppError.badRequest(
      'connectionId must be sent via header only',
      'events.connection_id_header_only'
    )
  }

  const lastRaw = c.req.header('Last-Event-ID')
  const parsedLast = lastRaw ? Number.parseInt(lastRaw, 10) : NaN
  const lastEventId = Number.isFinite(parsedLast) ? parsedLast : null

  assertSseClientCapacity(activeRealtimeKeys(), principal.userId, maxClientsPerUser)

  const key = realtimeKey(principal.userId, principal.sessionId, connectionId)
  const pending = (takePendingTopics(key) as RealtimeTopic[] | undefined) ?? []

  const handle: RealtimeStreamHandle = ctx.realtime.openStream({
    actorId: principal.userId,
    sessionId: principal.sessionId,
    connectionId,
    lastEventId,
    initialTopics: pending
  })
  bindRealtimeHandle(principal.userId, principal.sessionId, connectionId, handle)

  const bound: AuthPrincipal = { ...principal }

  return streamSSE(c, async (stream) => {
    c.header('Cache-Control', 'no-cache, no-transform')
    c.header('X-Accel-Buffering', 'no')

    let closed = false
    const recheck = setInterval(() => {
      if (closed) return
      if (!ctx.security.auth.isSessionActive(bound.sessionId, bound.userId)) {
        void stream
          .writeSSE({
            event: 'auth.session.expired',
            data: JSON.stringify({
              eventId: null,
              ephemeral: true,
              topic: 'settings:self',
              type: 'auth.session.expired',
              entityId: bound.sessionId,
              occurredAt: Date.now(),
              payload: { code: 'auth.session.expired' }
            })
          })
          .finally(() => {
            handle.close()
          })
      }
    }, SESSION_RECHECK_MS)
    recheck.unref?.()

    try {
      for await (const item of handle.stream) {
        if (!ctx.security.auth.isSessionActive(bound.sessionId, bound.userId)) {
          await stream.writeSSE({
            event: 'auth.session.expired',
            data: JSON.stringify({
              eventId: null,
              ephemeral: true,
              topic: 'settings:self',
              type: 'auth.session.expired',
              entityId: bound.sessionId,
              occurredAt: Date.now(),
              payload: { code: 'auth.session.expired' }
            })
          })
          break
        }
        if ('heartbeat' in item) {
          await stream.writeSSE({ event: 'ping', data: '' })
          continue
        }
        const sseEvent =
          item.type === 'realtime.resync-required' || item.type === 'auth.session.expired'
            ? item.type
            : 'domain'
        await stream.writeSSE({
          ...(item.ephemeral || item.eventId == null
            ? {}
            : { id: String(item.eventId) }),
          event: sseEvent,
          data: JSON.stringify(item)
        })
      }
    } finally {
      closed = true
      clearInterval(recheck)
      handle.close()
      unbindRealtimeHandle(key)
    }
  })
}

/** Unique realtime gateway — only /subscriptions and /stream (06). */
export function createRealtimeRoutes(ctx: AppContext): Hono {
  const routes = new Hono()
  routes.put('/subscriptions', (c) => handleSubscriptions(c))
  routes.get('/stream', (c) => handleStream(c, ctx))
  return routes
}

export {
  closeRealtimeForSession,
  closeRealtimeForUser
} from '../events/realtime-session-registry'
