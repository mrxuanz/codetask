import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OutboxDispatcher } from '../../../src/server/application/outbox-dispatcher'
import type { OutboxEvent, OutboxRepository } from '../../../src/server/application/ports/outbox-repository'

class MemoryOutboxRepository implements OutboxRepository {
  private nextId = 1
  private readonly events: Array<OutboxEvent & { dispatchedAtMs: number | null }> = []

  appendOutbox(input: {
    readonly topic: string
    readonly eventType: string
    readonly entityId: string
    readonly aggregateRevision: number
    readonly payload: unknown
    readonly createdAtMs: number
  }): number {
    const eventId = this.nextId++
    this.events.push({
      eventId,
      topic: input.topic,
      eventType: input.eventType,
      entityId: input.entityId,
      aggregateRevision: input.aggregateRevision,
      payloadJson: JSON.stringify(input.payload),
      dispatchedAtMs: null
    })
    return eventId
  }

  getUndispatchedEvents(batchSize: number): readonly OutboxEvent[] {
    return this.events
      .filter((event) => event.dispatchedAtMs === null)
      .slice(0, batchSize)
      .map(({ dispatchedAtMs: _dispatchedAtMs, ...event }) => event)
  }

  listOwnedOutboxEvents(): readonly OutboxEvent[] {
    return []
  }

  getOwnedOutboxLatestEventId(): number {
    return 0
  }

  markDispatched(input: { readonly eventIds: readonly number[]; readonly dispatchedAtMs: number }): void {
    for (const eventId of input.eventIds) {
      const row = this.events.find((event) => event.eventId === eventId)
      if (row) row.dispatchedAtMs = input.dispatchedAtMs
    }
  }
}

describe('OutboxDispatcher', () => {
  it('should reuse in-flight flush promise for concurrent callers', async () => {
    const outbox = new MemoryOutboxRepository()
    outbox.appendOutbox({
      topic: 'job:job-1',
      eventType: 'job.changed',
      entityId: 'job-1',
      aggregateRevision: 1,
      createdAtMs: Date.now(),
      payload: { type: 'job.changed' }
    })

    const published: number[] = []
    const dispatcher = new OutboxDispatcher(
      outbox,
      (event) => {
        published.push(event.eventId)
      },
      {
        debug() {
          void 0
        },
        info() {
          void 0
        },
        warn() {
          void 0
        },
        error() {
          void 0
        }
      },
      () => Date.now()
    )

    const first = dispatcher.flush()
    const second = dispatcher.flush()
    assert.equal(first, second)
    await first
    assert.deepEqual(published, [1])
  })

  it('should redeliver undispatched events after restart', async () => {
    const outbox = new MemoryOutboxRepository()
    outbox.appendOutbox({
      topic: 'job:job-1',
      eventType: 'job.changed',
      entityId: 'job-1',
      aggregateRevision: 1,
      createdAtMs: Date.now(),
      payload: { type: 'job.changed' }
    })

    const published: number[] = []
    const dispatcher = new OutboxDispatcher(
      outbox,
      (event) => {
        published.push(event.eventId)
        throw new Error('crash before markDispatched')
      },
      {
        debug() {
          void 0
        },
        info() {
          void 0
        },
        warn() {
          void 0
        },
        error() {
          void 0
        }
      },
      () => Date.now()
    )

    await dispatcher.flush()
    assert.equal(published.length, 1)
    assert.equal(outbox.getUndispatchedEvents(10).length, 1)

    const recovered: number[] = []
    const restarted = new OutboxDispatcher(
      outbox,
      (event) => recovered.push(event.eventId),
      {
        debug() {
          void 0
        },
        info() {
          void 0
        },
        warn() {
          void 0
        },
        error() {
          void 0
        }
      },
      () => Date.now()
    )
    await restarted.flush()
    assert.deepEqual(recovered, [1])
  })
})
