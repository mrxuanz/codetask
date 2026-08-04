import type { DurableRealtimeEnvelope, RealtimeEnvelope, RealtimeTopic } from '@codetask/contracts'
import type { RealtimeEventLog } from './event-log.ts'
import { LiveFanout, type RealtimeConnectionState } from './live-fanout.ts'

const HEARTBEAT_MS = 25_000

export type RealtimeStreamHandle = {
  connectionId: string
  setSubscriptions: (topics: RealtimeTopic[]) => void
  stream: AsyncGenerator<RealtimeEnvelope | { heartbeat: true }>
  close: () => void
  key: string
}

/**
 * Open an SSE connection: replay durable events, then yield live queue items.
 * Does NOT push business snapshots on subscribe.
 */
export function openRealtimeStream(input: {
  fanout: LiveFanout
  log: RealtimeEventLog
  actorId: string
  sessionId: string
  connectionId: string
  lastEventId: number | null
  initialTopics?: RealtimeTopic[]
}): RealtimeStreamHandle {
  const conn: RealtimeConnectionState = {
    actorId: input.actorId,
    sessionId: input.sessionId,
    connectionId: input.connectionId,
    topics: new Set(input.initialTopics ?? []),
    queue: [],
    queuedBytes: 0,
    lastDeliveredEventId: input.lastEventId ?? 0,
    resolveWait: null,
    closed: false,
    overflow: false
  }

  const key = input.fanout.register(conn)

  const replayIntoQueue = (topics: readonly string[]): void => {
    if (topics.length === 0) return
    const afterId = conn.lastDeliveredEventId
    const result = input.log.replayAfter({
      actorId: input.actorId,
      topics,
      afterEventId: afterId
    })
    if (result.gap) {
      input.fanout.publishToConnection(conn, {
        eventId: null,
        ephemeral: true,
        topic: topics[0]!,
        type: 'realtime.resync-required',
        entityId: input.connectionId,
        occurredAt: Date.now(),
        payload: { reason: 'gap', latestEventId: result.latestEventId }
      })
      return
    }
    for (const event of result.events) {
      conn.queue.push(event)
    }
  }

  // Initial replay if topics already known (pending subscription applied by caller).
  if (conn.topics.size > 0) {
    replayIntoQueue([...conn.topics])
  }

  const setSubscriptions = (topics: RealtimeTopic[]): void => {
    if (conn.closed) return
    const previous = new Set(conn.topics)
    const next = [...new Set(topics)]
    conn.topics = new Set(next)
    input.fanout.setTopics(key, next)

    const added = next.filter((topic) => !previous.has(topic))
    if (added.length > 0) {
      // Replay only newly added topics from last delivered cursor.
      replayIntoQueue(added)
    }
  }

  async function* stream(): AsyncGenerator<RealtimeEnvelope | { heartbeat: true }> {
    try {
      while (!conn.closed) {
        while (conn.queue.length > 0) {
          const item = conn.queue.shift()!
          if (!item.ephemeral && typeof item.eventId === 'number') {
            conn.lastDeliveredEventId = Math.max(conn.lastDeliveredEventId, item.eventId)
          }
          yield item
        }
        await new Promise<void>((resolve) => {
          conn.resolveWait = resolve
          setTimeout(resolve, HEARTBEAT_MS)
        })
        if (conn.closed) break
        if (conn.queue.length === 0) {
          yield { heartbeat: true }
        }
      }
    } finally {
      conn.closed = true
      input.fanout.unregister(key)
    }
  }

  return {
    connectionId: input.connectionId,
    setSubscriptions,
    stream: stream(),
    close: () => {
      conn.closed = true
      conn.resolveWait?.()
      conn.resolveWait = null
      input.fanout.unregister(key)
    },
    key
  }
}

export type { DurableRealtimeEnvelope }
