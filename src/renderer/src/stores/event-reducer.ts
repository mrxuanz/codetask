export interface EventEnvelope {
  readonly eventId: number
  readonly topic: string
  readonly type: string
  readonly entityId: string
  readonly revision: number
  readonly payload: unknown
}

export type EventHandler = (event: EventEnvelope) => void

export type ResyncReason = 'event_gap' | 'resync_required'

export type ResyncCallback = (info: {
  readonly reason: ResyncReason
  readonly lastEventId: number
  readonly newEventId: number
}) => void

export class EventReducer {
  private lastEventId = 0
  private needsResync = false
  private onResync: ResyncCallback | null = null
  private readonly handlers = new Map<string, EventHandler[]>()

  setResyncCallback(callback: ResyncCallback): void {
    this.onResync = callback
  }

  getNeedsResync(): boolean {
    return this.needsResync
  }

  clearNeedsResync(): void {
    this.needsResync = false
  }

  resetCursor(nextLastEventId = 0): void {
    this.lastEventId =
      Number.isInteger(nextLastEventId) && nextLastEventId > 0 ? nextLastEventId : 0
    this.needsResync = false
  }

  registerHandler(eventType: string, handler: EventHandler): void {
    const handlers = this.handlers.get(eventType) ?? []
    handlers.push(handler)
    this.handlers.set(eventType, handlers)
  }

  reduce(event: EventEnvelope): void {
    if (event.eventId <= this.lastEventId) {
      return
    }

    if (event.eventId > this.lastEventId + 1) {
      this.handleGap(event.eventId)
      return
    }

    this.lastEventId = event.eventId

    const handlers = this.handlers.get(event.type) ?? []
    for (const handler of handlers) {
      handler(event)
    }
  }

  private handleGap(newEventId: number): void {
    this.needsResync = true
    this.onResync?.({
      reason: 'event_gap',
      lastEventId: this.lastEventId,
      newEventId
    })
  }

  getLastEventId(): number {
    return this.lastEventId
  }
}
