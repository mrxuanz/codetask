import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatLegacyHubSse,
  mapOutboxEventToLegacyHub,
  mapOutboxEventToLegacySseFrame,
  mapResyncToLegacyHub
} from '../../../src/server/compatibility/legacy-sse-mapper.ts'

const here = dirname(fileURLToPath(import.meta.url))
const reconnectFixture = JSON.parse(
  readFileSync(
    join(here, '../../../docs/refactor/fixtures/sse/reconnect.sample.json'),
    'utf8'
  )
) as {
  gapResync: { topic: string; seq: number; event: string; data: { reason: string } }
  afterResubscribeSnapshots: Array<{
    topic: string
    seq: number
    event: string
    data: Record<string, unknown>
  }>
  v3OutboxEnvelopeExample: {
    eventId: number
    topic: string
    type: string
    entityId: string
    revision: number
    payload: Record<string, unknown>
  }
}

describe('legacy-sse-mapper', () => {
  it('maps outbox job.changed to legacy hub job_snapshot', () => {
    const outbox = reconnectFixture.v3OutboxEnvelopeExample
    const hub = mapOutboxEventToLegacyHub({
      eventId: outbox.eventId,
      topic: outbox.topic,
      type: outbox.type,
      entityId: outbox.entityId,
      revision: outbox.revision,
      payload: outbox.payload
    })
    assert.equal(hub.topic, outbox.topic)
    assert.equal(hub.seq, outbox.eventId)
    assert.equal(hub.event, 'job_snapshot')
    assert.equal(typeof hub.data, 'object')
    assert.ok(hub.data !== null && 'job' in (hub.data as object))
    const job = (hub.data as { job: { id: string; status: string } }).job
    assert.equal(job.id, 'job-sample-001')
    assert.equal(job.status, 'running')
  })

  it('maps resync control to fixture gapResync keys', () => {
    const expected = reconnectFixture.gapResync
    const hub = mapResyncToLegacyHub({ seq: expected.seq, reason: expected.data.reason })
    assert.equal(hub.topic, expected.topic)
    assert.equal(hub.seq, expected.seq)
    assert.equal(hub.event, expected.event)
    assert.deepEqual(hub.data, expected.data)
  })

  it('preserves snapshot event names from fixture afterResubscribeSnapshots', () => {
    for (const sample of reconnectFixture.afterResubscribeSnapshots) {
      const typeByEvent: Record<string, string> = {
        job_snapshot: 'job.changed',
        plan_progress: 'plan_progress',
        task_progress: 'task_progress',
        thread_snapshot: 'thread_snapshot',
        turn_snapshot: 'turn_snapshot'
      }
      const type = typeByEvent[sample.event]
      assert.ok(type, `unexpected fixture event ${sample.event}`)
      const hub = mapOutboxEventToLegacyHub({
        eventId: sample.seq,
        topic: sample.topic,
        type,
        entityId: sample.topic.split(':')[1] ?? 'entity',
        revision: sample.seq,
        payload: sample.data
      })
      assert.equal(hub.event, sample.event)
      assert.equal(hub.seq, sample.seq)
      assert.equal(hub.topic, sample.topic)
      for (const key of Object.keys(sample.data)) {
        assert.ok(key in (hub.data as object), `missing data key ${key}`)
      }
    }
  })

  it('formats SSE wire as event: hub with id = seq', () => {
    const frame = mapOutboxEventToLegacySseFrame({
      eventId: 44,
      topic: 'job:job-sample-001',
      type: 'job.changed',
      entityId: 'job-sample-001',
      revision: 1,
      payload: { jobId: 'job-sample-001', status: 'running' }
    })
    assert.equal(frame.sseEventName, 'hub')
    assert.equal(frame.id, 44)
    const text = formatLegacyHubSse(frame)
    assert.match(text, /^id: 44\n/)
    assert.match(text, /\nevent: hub\n/)
    assert.match(text, /\ndata: \{/)
  })
})
