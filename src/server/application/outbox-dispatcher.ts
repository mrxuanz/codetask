import type { JobRepository, OutboxEvent } from './ports/job-repository'
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
    private readonly jobRepository: JobRepository,
    private readonly publisher: EventPublisher,
    private readonly logger: SafeLogger,
    private readonly config: OutboxDispatcherConfig = { batchSize: 50, pollIntervalMs: 1000 }
  ) {}

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.pollTimer = setInterval(() => void this.dispatch(), this.config.pollIntervalMs)
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

  async flushWithin(deadlineMs: number): Promise<void> {
    const deadline = Date.now() + deadlineMs
    this.flushing = this.flushUntilDeadline(deadline)
    try {
      await this.flushing
    } finally {
      this.flushing = null
    }
  }

  private async flushUntilDeadline(deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const dispatched = this.dispatchBatch()
      if (dispatched === 0) return
    }
  }

  private async dispatch(): Promise<void> {
    if (!this.running) return
    this.dispatchBatch()
  }

  private dispatchBatch(): number {
    const events = this.jobRepository.getUndispatchedEvents(this.config.batchSize)
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
      this.jobRepository.markDispatched(ids)
    }

    return events.length
  }
}
