import type { ApplicationEvent, EventPublisher } from '../../core/application/ports/event-publisher'
import type { UnitOfWork } from '../../core/application/ports/unit-of-work'

/**
 * In-memory UoW: collects events during `run`; on successful commit moves them
 * to an outbox, then optionally drains (publishes). Discard on failure.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  private pending: ApplicationEvent[] = []
  private depth = 0
  /** Durable outbox after commit (survives publish failures). */
  readonly outbox: ApplicationEvent[] = []
  /** When false, commit leaves events in outbox without publishing. */
  autoDrain = true
  /** Optional fault: throw after commit, before/during drain. */
  publishFault: Error | null = null

  constructor(private readonly publisher: EventPublisher) {}

  enqueueEvent(event: ApplicationEvent): void {
    this.pending.push(event)
  }

  /** Events collected in the current (outer) transaction — for tests. */
  get pendingEvents(): readonly ApplicationEvent[] {
    return this.pending
  }

  async run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const isOuter = this.depth === 0
    if (isOuter) {
      this.pending = []
    }
    this.depth += 1
    try {
      const result = await fn(this)
      if (isOuter) {
        const toCommit = [...this.pending]
        this.pending = []
        this.outbox.push(...toCommit)
        if (this.autoDrain) {
          await this.drainOutbox()
        }
      }
      return result
    } catch (error: unknown) {
      if (isOuter) {
        this.pending = []
      }
      throw error
    } finally {
      this.depth -= 1
    }
  }

  async drainOutbox(): Promise<number> {
    if (this.publishFault) {
      throw this.publishFault
    }
    let count = 0
    while (this.outbox.length > 0) {
      if (this.publishFault) {
        throw this.publishFault
      }
      const event = this.outbox.shift()!
      await this.publisher.publish(event)
      count += 1
    }
    return count
  }
}
