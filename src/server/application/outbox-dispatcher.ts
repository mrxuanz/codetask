import type { OutboxRepository, OutboxEvent } from './ports/outbox-repository'
import type { SafeLogger } from './ports/safe-logger'

export interface OutboxDispatcherConfig {
  readonly batchSize: number
  readonly pollIntervalMs: number
}

export type EventPublisher = (event: OutboxEvent) => void

export class OutboxDispatcher {
  private running = false
  private pollTimer: NodeJS.Timeout | null = null
  private flushing: Promise<void> | null = null

  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly logger: SafeLogger,
    private readonly nowMs: () => number,
    private readonly config: OutboxDispatcherConfig = { batchSize: 50, pollIntervalMs: 1000 }
  ) {}

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.pollTimer = setInterval(() => void this.flush(), this.config.pollIntervalMs)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.flushing) {
      await this.flushing
    }
  }

  flush(): Promise<void> {
    if (this.flushing !== null) {
      return this.flushing
    }

    this.flushing = this.flushLoop().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  async flushWithin(deadlineMs: number): Promise<void> {
    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline) {
      await this.flush()
      if (this.outboxRepository.getUndispatchedEvents(1).length === 0) {
        return
      }
    }
  }

  private async flushLoop(): Promise<void> {
    while (this.dispatchBatch() > 0) {
      // Drain committed outbox rows serially before accepting the next flush.
    }
  }

  private dispatchBatch(): number {
    const events = this.outboxRepository.getUndispatchedEvents(this.config.batchSize)
    if (events.length === 0) return 0

    const ids: number[] = []
    for (const event of events) {
      try {
        this.publisher(event)
        ids.push(event.eventId)
      } catch (error: unknown) {
        this.logger.error('Failed to publish outbox event', {
          eventId: event.eventId,
          topic: event.topic,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    if (ids.length > 0) {
      this.outboxRepository.markDispatched({ eventIds: ids, dispatchedAtMs: this.nowMs() })
    }

    return ids.length
  }
}
