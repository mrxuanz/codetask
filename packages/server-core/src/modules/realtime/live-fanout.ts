import type { RealtimeEnvelope, RealtimeTopic } from '@codetask/contracts'

export type RealtimeConnectionState = {
  actorId: string
  sessionId: string
  connectionId: string
  topics: Set<string>
  queue: RealtimeEnvelope[]
  queuedBytes: number
  lastDeliveredEventId: number
  resolveWait: (() => void) | null
  closed: boolean
  overflow: boolean
}

const MAX_QUEUE_EVENTS = 256
const MAX_QUEUE_BYTES = 512 * 1024

const PROGRESS_TYPES = new Set([
  'planning.progress',
  'job.queue.changed',
  'assistant.thinking.delta',
  'assistant.text.delta'
])

const NEVER_DROP_TYPES = new Set([
  'realtime.resync-required',
  'auth.session.expired',
  'message.committed',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'job.completed',
  'planning.published',
  'planning.failed',
  'settings.changed'
])

function envelopeBytes(envelope: RealtimeEnvelope): number {
  try {
    return Buffer.byteLength(JSON.stringify(envelope), 'utf8')
  } catch {
    return 1024
  }
}

function isProgress(envelope: RealtimeEnvelope): boolean {
  return PROGRESS_TYPES.has(envelope.type)
}

/**
 * Per-connection bounded queue with progress coalescing and byte limits.
 */
export class LiveFanout {
  private readonly connections = new Map<string, RealtimeConnectionState>()

  static connectionKey(actorId: string, sessionId: string, connectionId: string): string {
    return `${actorId}::${sessionId}::${connectionId}`
  }

  register(conn: RealtimeConnectionState): string {
    const key = LiveFanout.connectionKey(conn.actorId, conn.sessionId, conn.connectionId)
    const prior = this.connections.get(key)
    if (prior && !prior.closed) {
      prior.closed = true
      this.notify(prior)
    }
    this.connections.set(key, conn)
    return key
  }

  get(key: string): RealtimeConnectionState | undefined {
    return this.connections.get(key)
  }

  unregister(key: string): void {
    this.connections.delete(key)
  }

  activeKeys(): IterableIterator<string> {
    return this.connections.keys()
  }

  setTopics(key: string, topics: readonly string[]): void {
    const conn = this.connections.get(key)
    if (!conn || conn.closed) return
    conn.topics = new Set(topics)
  }

  /** Deliver to all open connections subscribed to the topic for the actor.
   * `settings:self` is broadcast to every subscriber (global settings). */
  publish(actorId: string, envelope: RealtimeEnvelope): void {
    const broadcast = envelope.topic === 'settings:self'
    for (const conn of this.connections.values()) {
      if (conn.closed) continue
      if (!broadcast && conn.actorId !== actorId) continue
      if (!conn.topics.has(envelope.topic)) continue
      this.enqueue(conn, envelope)
    }
  }

  /** Deliver a control envelope to one connection regardless of topics. */
  publishToConnection(conn: RealtimeConnectionState, envelope: RealtimeEnvelope): void {
    if (conn.closed) return
    this.enqueue(conn, envelope)
  }

  closeForSession(actorId: string, sessionId: string): void {
    const needle = `${actorId}::${sessionId}::`
    for (const [key, conn] of this.connections) {
      if (!key.startsWith(needle)) continue
      conn.closed = true
      this.notify(conn)
      this.connections.delete(key)
    }
  }

  closeForActor(actorId: string): void {
    const prefix = `${actorId}::`
    for (const [key, conn] of [...this.connections.entries()]) {
      if (!key.startsWith(prefix)) continue
      conn.closed = true
      this.notify(conn)
      this.connections.delete(key)
    }
  }

  private enqueue(conn: RealtimeConnectionState, envelope: RealtimeEnvelope): void {
    if (isProgress(envelope)) {
      for (let i = conn.queue.length - 1; i >= 0; i -= 1) {
        const existing = conn.queue[i]
        if (
          existing &&
          existing.topic === envelope.topic &&
          existing.type === envelope.type &&
          existing.entityId === envelope.entityId
        ) {
          const prevBytes = envelopeBytes(existing)
          conn.queue[i] = envelope
          conn.queuedBytes = conn.queuedBytes - prevBytes + envelopeBytes(envelope)
          this.notify(conn)
          return
        }
      }
    }

    const bytes = envelopeBytes(envelope)
    conn.queue.push(envelope)
    conn.queuedBytes += bytes
    this.trim(conn)
    this.notify(conn)
  }

  private trim(conn: RealtimeConnectionState): void {
    while (
      (conn.queue.length > MAX_QUEUE_EVENTS || conn.queuedBytes > MAX_QUEUE_BYTES) &&
      conn.queue.length > 0
    ) {
      const dropIndex = conn.queue.findIndex((item) => !NEVER_DROP_TYPES.has(item.type))
      if (dropIndex < 0) {
        conn.overflow = true
        const resync: RealtimeEnvelope = {
          eventId: null,
          ephemeral: true,
          topic:
            (conn.topics.values().next().value as RealtimeTopic | undefined) ?? 'settings:self',
          type: 'realtime.resync-required',
          entityId: conn.connectionId,
          occurredAt: Date.now(),
          payload: { reason: 'overflow' }
        }
        conn.queue.length = 0
        conn.queuedBytes = 0
        conn.queue.push(resync)
        conn.queuedBytes = envelopeBytes(resync)
        return
      }
      const [removed] = conn.queue.splice(dropIndex, 1)
      if (removed) conn.queuedBytes = Math.max(0, conn.queuedBytes - envelopeBytes(removed))
    }
  }

  private notify(conn: RealtimeConnectionState): void {
    conn.resolveWait?.()
    conn.resolveWait = null
  }
}
