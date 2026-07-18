import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JobEventHub } from '@server/application/job-event-hub'
import {
  parseControlPlaneJobChangedEnvelope,
  parseControlPlaneResyncRequiredEvent
} from '../../../src/renderer/src/api/v3-events'
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
import { CommandError } from '@server/domain/jobs/job-errors'

describe('API V3 headers', () => {
  it('should require If-Match header', () => {
    assert.throws(
      () => parseIfMatch(undefined),
      (error: unknown) => error instanceof CommandError && error.code === 'contract.invalid_payload'
    )
  })

  it('should require Idempotency-Key header', () => {
    assert.throws(
      () => parseIdempotencyKey(undefined),
      (error: unknown) => error instanceof CommandError && error.code === 'contract.invalid_payload'
    )
  })

  it('should reject weak ETag', () => {
    assert.throws(
      () => parseIfMatch('W/"91"'),
      (error: unknown) => error instanceof CommandError && error.code === 'contract.invalid_payload'
    )
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

describe('Renderer event-reducer owner-safe cursor', () => {
  it('should accept non-contiguous global event ids without false gap resync', () => {
    const reducer = new EventReducer()
    let handled = 0
    reducer.registerHandler('job.changed', () => {
      handled += 1
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
      eventId: 5,
      topic: 'job:job-1',
      type: 'job.changed',
      entityId: 'job-1',
      revision: 2,
      payload: {}
    })

    assert.equal(handled, 2)
    assert.equal(reducer.getLastEventId(), 5)
  })

  it('should ignore duplicate replayed event ids', () => {
    const reducer = new EventReducer()
    let handled = 0
    reducer.registerHandler('job.changed', () => {
      handled += 1
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
      eventId: 1,
      topic: 'job:job-1',
      type: 'job.changed',
      entityId: 'job-1',
      revision: 1,
      payload: {}
    })

    assert.equal(handled, 1)
  })
})

describe('Renderer V3 event parsing', () => {
  it('should parse valid control-plane job.changed envelope', () => {
    const envelope = parseControlPlaneJobChangedEnvelope({
      eventId: 5,
      topic: 'job:job-1',
      type: 'job.changed',
      entityId: 'job-1',
      revision: 7,
      payload: {
        eventId: 5,
        topic: 'job:job-1',
        type: 'job.changed',
        entityId: 'job-1',
        revision: 7,
        changed: ['state', 'tasks']
      }
    })

    assert.notEqual(envelope, null)
    assert.deepEqual(envelope?.changed, ['state', 'tasks'])
  })

  it('should reject mismatched payload metadata', () => {
    const envelope = parseControlPlaneJobChangedEnvelope({
      eventId: 5,
      topic: 'job:job-1',
      type: 'job.changed',
      entityId: 'job-1',
      revision: 7,
      payload: {
        eventId: 6,
        topic: 'job:job-1',
        type: 'job.changed',
        entityId: 'job-1',
        revision: 7,
        changed: ['state']
      }
    })

    assert.equal(envelope, null)
  })

  it('should parse resync_required payload', () => {
    const payload = parseControlPlaneResyncRequiredEvent({
      reason: 'cursor_too_old',
      restartFromEventId: 42
    })

    assert.deepEqual(payload, {
      reason: 'cursor_too_old',
      restartFromEventId: 42
    })
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
