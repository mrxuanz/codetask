import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JobEventHub } from '@server/application/job-event-hub'
import { EventReducer } from '../../../src/renderer/src/stores/event-reducer'
import { reduceJobSnapshot } from '../../../src/renderer/src/stores/entity-store'
import {
  canDelete,
  canCancel,
  filterActions,
  shouldShowDelete
} from '../../../src/renderer/src/stores/ui-actions'
import {
  parseIfMatch,
  parseIdempotencyKey
} from '@server/http/v3/headers'

describe('API V3 headers', () => {
  it('should require If-Match header', () => {
    assert.throws(() => parseIfMatch(undefined), /If-Match header required/)
  })

  it('should require Idempotency-Key header', () => {
    assert.throws(() => parseIdempotencyKey(undefined), /Idempotency-Key header required/)
  })

  it('should reject weak ETag', () => {
    assert.throws(() => parseIfMatch('W/"91"'), /Invalid If-Match/)
  })

  it('should accept strong ETag', () => {
    assert.equal(parseIfMatch('"42"'), 42)
  })

  it('should accept valid UUID idempotency key', () => {
    const key = '550e8400-e29b-41d4-a716-446655440000'
    assert.equal(parseIdempotencyKey(key), key)
  })
})

describe('Renderer entity-store merge', () => {
  it('should reject stale revision', () => {
    const current = { revision: 10, entity: { id: 'job-1', stateRevision: 10, state: 'paused' } }
    const decision = reduceJobSnapshot(current, { id: 'job-1', stateRevision: 9 }, 'incremental_event')
    assert.equal(decision.kind, 'ignore_stale')
  })

  it('should detect gap and resync', () => {
    const current = { revision: 10, entity: { id: 'job-1', stateRevision: 10, state: 'paused' } }
    const decision = reduceJobSnapshot(current, { id: 'job-1', stateRevision: 12 }, 'incremental_event')
    assert.equal(decision.kind, 'resync')
    if (decision.kind === 'resync') {
      assert.equal(decision.entityId, 'job-1')
    }
  })

  it('should accept sequential revision', () => {
    const current = { revision: 10, entity: { id: 'job-1', stateRevision: 10, state: 'paused' } }
    const incoming = { id: 'job-1', stateRevision: 11, state: 'execution_running' }
    const decision = reduceJobSnapshot(current, incoming, 'incremental_event')
    assert.equal(decision.kind, 'accept')
  })
})

describe('Renderer event-reducer gap', () => {
  it('should detect gap and expose needsResync', () => {
    const reducer = new EventReducer()
    const resyncEvents: Array<{ reason: string; lastEventId: number; newEventId: number }> = []
    reducer.setResyncCallback((info) => {
      resyncEvents.push(info)
    })

    reducer.reduce({
      eventId: 1,
      topic: 'job:job-1',
      type: 'job.changed',
      entityId: 'job-1',
      revision: 1,
      payload: {}
    })

    reducer.reduce({
      eventId: 3,
      topic: 'job:job-1',
      type: 'job.changed',
      entityId: 'job-1',
      revision: 3,
      payload: {}
    })

    assert.equal(reducer.getNeedsResync(), true)
    assert.equal(resyncEvents.length, 1)
    assert.equal(resyncEvents[0]?.reason, 'event_gap')
    assert.equal(resyncEvents[0]?.lastEventId, 1)
    assert.equal(resyncEvents[0]?.newEventId, 3)
  })
})

describe('Renderer action wiring', () => {
  it('should render availableActions only', () => {
    const actions = ['pause', 'cancel']
    assert.equal(canCancel(actions), true)
    assert.equal(canDelete(actions), false)
  })

  it('should hide delete for active job', () => {
    const job = {
      state: 'execution_running',
      availableActions: ['pause', 'cancel', 'delete'] as const
    }
    assert.equal(shouldShowDelete(job), false)
    assert.deepEqual(filterActions(job.availableActions, job), ['pause', 'cancel'])
  })
})

describe('Job event hub coalesce', () => {
  it('should coalesce same topic events', () => {
    const hub = new JobEventHub({ maxQueueSize: 10, coalesceWindowMs: 100 })
    const sent: unknown[] = []
    hub.registerConnection('job:job-1', {
      send(event: unknown) {
        sent.push(event)
      }
    })

    hub.push('job:job-1', 1, { revision: 1 })
    hub.push('job:job-1', 2, { revision: 2 })
    hub.push('job:job-1', 3, { revision: 3 })
    hub.flush()

    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0], { revision: 3 })
  })
})
