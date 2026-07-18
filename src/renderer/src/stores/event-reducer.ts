export interface EventEnvelope {
  readonly eventId: number
  readonly topic: string
  readonly type: string
  readonly entityId: string
  readonly revision: number
  readonly payload: unknown
}

export type EventHandler = (event: EventEnvelope) => void

/**
 * Tracks the opaque global SSE cursor. Owner-filtered streams may skip event IDs;
 * entity revision gaps are handled by entity stores and REST resync — not here.
 */
export class EventReducer {
  private lastEventId = 0
  private readonly handlers = new Map<string, EventHandler[]>()

  registerHandler(eventType: string, handler: EventHandler): void {
    const handlers = this.handlers.get(eventType) ?? []
    handlers.push(handler)
    this.handlers.set(eventType, handlers)
  }

  reduce(event: EventEnvelope): void {
    if (event.eventId <= this.lastEventId) {
      return
    }

    this.lastEventId = event.eventId

    const handlers = this.handlers.get(event.type) ?? []
    for (const handler of handlers) {
      handler(event)
    }
  }

  resetCursor(nextLastEventId = 0): void {
    this.lastEventId =
      Number.isInteger(nextLastEventId) && nextLastEventId > 0 ? nextLastEventId : 0
  }

  getLastEventId(): number {
    return this.lastEventId
  }
}
