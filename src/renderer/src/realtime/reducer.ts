import type { RealtimeEnvelope } from '@codetask/contracts'

export type RealtimeEventHandler = (event: RealtimeEnvelope) => void

/**
 * Tracks the durable SSE cursor. Ephemeral events do not advance it.
 * Entity revision gaps are handled by entity stores + REST resync.
 */
export class RealtimeReducer {
  private lastEventId = 0
  private readonly handlers = new Map<string, RealtimeEventHandler[]>()
  private readonly entityRevisions = new Map<string, number>()

  registerHandler(eventType: string, handler: RealtimeEventHandler): void {
    const handlers = this.handlers.get(eventType) ?? []
    handlers.push(handler)
    this.handlers.set(eventType, handlers)
  }

  reduce(event: RealtimeEnvelope): boolean {
    if (!event.ephemeral && typeof event.eventId === 'number') {
      if (event.eventId <= this.lastEventId) {
        return false
      }
      this.lastEventId = event.eventId
    }

    if (!event.ephemeral && 'entityRevision' in event) {
      const key = `${event.topic}:${event.entityId}`
      const prev = this.entityRevisions.get(key) ?? 0
      if (event.entityRevision < prev) {
        return false
      }
      this.entityRevisions.set(key, event.entityRevision)
    }

    const handlers = this.handlers.get(event.type) ?? []
    for (const handler of handlers) {
      handler(event)
    }
    return true
  }

  resetCursor(nextLastEventId = 0): void {
    this.lastEventId =
      Number.isInteger(nextLastEventId) && nextLastEventId > 0 ? nextLastEventId : 0
  }

  getLastEventId(): number {
    return this.lastEventId
  }

  clearEntityRevisions(): void {
    this.entityRevisions.clear()
  }
}
