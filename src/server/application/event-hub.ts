import type { SafeLogger } from './ports/safe-logger'
import type { SseEnvelope } from '../http/v3/sse-envelope'

export interface EventHubConfig {
  readonly maxQueueSize: number
  readonly maxQueueBytes: number
}

interface Subscription {
  readonly connectionId: string
  readonly callback: (event: SseEnvelope) => void
  readonly onOverflow: (info: SlowConsumerInfo) => void
  queue: SseEnvelope[]
  queuedBytes: number
  lastDeliveredEventId: number
}

export interface SlowConsumerInfo {
  readonly lastDeliveredEventId: number
  readonly latestEventId: number
}

export class EventHub {
  private subscriptions = new Map<string, Subscription>()
  private dispatching = false
  private readonly config: EventHubConfig
  private readonly logger: SafeLogger

  constructor(config: EventHubConfig, logger: SafeLogger) {
    this.config = config
    this.logger = logger
  }

  subscribe(
    connectionId: string,
    callback: (event: SseEnvelope) => void,
    onOverflow: (info: SlowConsumerInfo) => void = () => {}
  ): () => void {
    const sub: Subscription = {
      connectionId,
      callback,
      onOverflow,
      queue: [],
      queuedBytes: 0,
      lastDeliveredEventId: 0
    }
    this.subscriptions.set(connectionId, sub)

    return () => {
      this.subscriptions.delete(connectionId)
    }
  }

  publish(event: SseEnvelope): void {
    for (const sub of [...this.subscriptions.values()]) {
      this.enqueue(sub, event)
    }
    this.dispatch()
  }

  private dispatch(): void {
    if (this.dispatching) return
    this.dispatching = true
    try {
      for (;;) {
        let delivered = false
        for (const sub of [...this.subscriptions.values()]) {
          const event = sub.queue.shift()
          if (!event) continue
          sub.queuedBytes -= this.serializedBytes(event)
          delivered = true
          try {
            sub.lastDeliveredEventId = event.eventId
            sub.callback(event)
          } catch {
            this.subscriptions.delete(sub.connectionId)
          }
        }
        if (!delivered) return
      }
    } finally {
      this.dispatching = false
    }
  }

  private enqueue(sub: Subscription, event: SseEnvelope): void {
    const existingIndex = sub.queue.findIndex(
      (pending) => pending.entityId === event.entityId && pending.topic === event.topic
    )

    if (existingIndex >= 0) {
      const existing = sub.queue[existingIndex]
      if (!existing || event.revision <= existing.revision) return
      sub.queuedBytes -= this.serializedBytes(existing)
      sub.queue[existingIndex] = event
      sub.queuedBytes += this.serializedBytes(event)
    } else {
      sub.queue.push(event)
      sub.queuedBytes += this.serializedBytes(event)
    }

    if (sub.queue.length > this.config.maxQueueSize || sub.queuedBytes > this.config.maxQueueBytes) {
      this.closeSlowConsumer(sub, event.eventId)
    }
  }

  private closeSlowConsumer(sub: Subscription, latestEventId: number): void {
    if (!this.subscriptions.delete(sub.connectionId)) return
    sub.queue = []
    sub.queuedBytes = 0
    this.logger.warn('Event connection overflow; requiring resync', {
      connectionId: sub.connectionId,
      lastDeliveredEventId: sub.lastDeliveredEventId,
      latestEventId
    })
    try {
      sub.onOverflow({
        lastDeliveredEventId: sub.lastDeliveredEventId,
        latestEventId
      })
    } catch {
      // The connection was already closed; it is isolated from other subscribers.
    }
  }

  private serializedBytes(event: SseEnvelope): number {
    return JSON.stringify(event).length
  }

  getSubscriberCount(): number {
    return this.subscriptions.size
  }

  getQueueSize(): number {
    let size = 0
    for (const sub of this.subscriptions.values()) {
      size += sub.queue.length
    }
    return size
  }
}
