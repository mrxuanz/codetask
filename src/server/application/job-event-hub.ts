export interface EventHubConfig {
  readonly maxQueueSize: number
  readonly coalesceWindowMs: number
}

interface PendingEvent {
  readonly topic: string
  readonly eventId: number
  readonly payload: unknown
  readonly timestamp: number
}

export class JobEventHub {
  private readonly queues = new Map<string, PendingEvent[]>()
  private readonly connections = new Map<string, { send: (event: unknown) => void }>()

  constructor(private readonly config: EventHubConfig) {}

  push(topic: string, eventId: number, payload: unknown): void {
    let queue = this.queues.get(topic)
    if (!queue) {
      queue = []
      this.queues.set(topic, queue)
    }

    // Coalesce: replace existing event for same topic within the coalesce window
    const existing = queue.findIndex(e => e.topic === topic)
    if (existing >= 0) {
      const previous = queue[existing]
      if (previous !== undefined && Date.now() - previous.timestamp < this.config.coalesceWindowMs) {
        queue[existing] = { topic, eventId, payload, timestamp: Date.now() }
        return
      }
    }

    if (queue.length >= this.config.maxQueueSize) {
      this.sendResyncAndClose(topic)
      return
    }
    queue.push({ topic, eventId, payload, timestamp: Date.now() })
  }

  private sendResyncAndClose(topic: string): void {
    const connection = this.connections.get(topic)
    if (connection) {
      connection.send({ type: 'resync_required', reason: 'slow_consumer' })
      this.connections.delete(topic)
    }
    this.queues.delete(topic)
  }

  registerConnection(topic: string, connection: { send: (event: unknown) => void }): void {
    this.connections.set(topic, connection)
  }

  flush(): void {
    for (const [topic, queue] of this.queues.entries()) {
      const connection = this.connections.get(topic)
      if (!connection) continue

      while (queue.length > 0) {
        const event = queue.shift()
        if (event) {
          connection.send(event.payload)
        }
      }
    }
  }
}
