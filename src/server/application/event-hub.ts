import type { SafeLogger } from './ports/safe-logger'
import type { SseEnvelope } from '../http/v3/sse-envelope'

export interface EventHubConfig {
  readonly maxQueueSize: number
  readonly maxQueueBytes: number
}

interface Subscription {
  readonly connectionId: string
  readonly callback: (event: SseEnvelope) => void
}

export class EventHub {
  private subscriptions = new Map<string, Subscription>()
  private queue: SseEnvelope[] = []
  private readonly config: EventHubConfig
  private readonly logger: SafeLogger

  constructor(config: EventHubConfig, logger: SafeLogger) {
    this.config = config
    this.logger = logger
  }

  subscribe(connectionId: string, callback: (event: SseEnvelope) => void): () => void {
    const sub: Subscription = { connectionId, callback }
    this.subscriptions.set(connectionId, sub)

    return () => {
      this.subscriptions.delete(connectionId)
    }
  }

  publish(event: SseEnvelope): void {
    // Coalesce: only keep latest event per entity
    const existingIndex = this.queue.findIndex(
      (e) => e.entityId === event.entityId && e.topic === event.topic
    )

    if (existingIndex >= 0) {
      // Replace with newer event (higher revision)
      const existing = this.queue[existingIndex]
      if (existing && event.revision > existing.revision) {
        this.queue[existingIndex] = event
      }
    } else {
      this.queue.push(event)
    }

    // Enforce queue limits
    this.enforceLimits()

    // Dispatch to subscribers
    this.dispatch()
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const event = this.queue.shift()
      if (!event) break

      const deadSubs: string[] = []
      for (const sub of this.subscriptions.values()) {
        try {
          sub.callback(event)
        } catch {
          deadSubs.push(sub.connectionId)
        }
      }

      // Clean up dead subscriptions
      for (const id of deadSubs) {
        this.subscriptions.delete(id)
      }
    }
  }

  private enforceLimits(): void {
    // Enforce count limit
    while (this.queue.length > this.config.maxQueueSize) {
      const dropped = this.queue.shift()
      if (dropped) {
        this.logger.warn('Event queue overflow, dropped oldest', {
          entityId: dropped.entityId,
          revision: dropped.revision
        })
      }
    }

    // Enforce bytes limit (approximate)
    let totalBytes = 0
    for (let i = this.queue.length - 1; i >= 0; i--) {
      totalBytes += JSON.stringify(this.queue[i]).length
      if (totalBytes > this.config.maxQueueBytes) {
        const dropped = this.queue.splice(0, i + 1)
        this.logger.warn('Event queue byte limit exceeded, dropped oldest', {
          droppedCount: dropped.length
        })
        break
      }
    }
  }

  getSubscriberCount(): number {
    return this.subscriptions.size
  }

  getQueueSize(): number {
    return this.queue.length
  }
}
