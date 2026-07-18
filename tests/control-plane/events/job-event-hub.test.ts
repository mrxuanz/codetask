import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JobEventHub } from '@server/application/job-event-hub'

describe('JobEventHub backpressure', () => {
  it('coalesce replaces same-topic pending event', () => {
    const hub = new JobEventHub({ maxQueueSize: 10, coalesceWindowMs: 1000 })
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

  it('overflow triggers resync_required instead of dropping oldest', () => {
    const hub = new JobEventHub({ maxQueueSize: 2, coalesceWindowMs: 0 })
    const sent: unknown[] = []
    let connectionOpen = true

    hub.registerConnection('job:job-1', {
      send(event: unknown) {
        sent.push(event)
        if (
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          (event as { type: string }).type === 'resync_required'
        ) {
          connectionOpen = false
        }
      }
    })

    hub.push('job:job-1', 1, { revision: 1 })
    hub.push('job:job-1', 2, { revision: 2 })
    hub.push('job:job-1', 3, { revision: 3 })

    assert.equal(connectionOpen, false)
    assert.ok(
      sent.some(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          (event as { type: string }).type === 'resync_required'
      )
    )

    const payloadOnly = sent.filter(
      (event) =>
        typeof event === 'object' &&
        event !== null &&
        !('type' in event && (event as { type: string }).type === 'resync_required')
    )
    assert.equal(payloadOnly.length, 0, 'overflow must not silently drop oldest pending events')
  })
})
