import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getControlPlaneReplayEvents,
  getControlPlaneRuntime
} from '../../../src/server/application/control-plane-runtime'
import {
  bootAuthoritativeRuntime,
  seedControlJob,
  withCompositionContext
} from './fixtures'
import { EventReducer } from '../../../src/renderer/src/stores/event-reducer'

describe('composition: owner-safe SSE cursor (CR6)', () => {
  it('replays only owner-scoped outbox events via production runtime', async () => {
    await withCompositionContext(
      {
        generation: 'v3_authoritative',
        seed(db) {
          seedControlJob(db, { jobId: 'job-1', username: 'u1', state: 'execution_queued' })
          seedControlJob(db, { jobId: 'job-2', username: 'u2', state: 'execution_queued' })
          const now = Date.now()
          db.prepare(
            `INSERT INTO control_outbox_events (
              topic, event_type, entity_id, aggregate_revision, payload_json, payload_bytes, created_at_ms
            ) VALUES (?, 'job.changed', ?, 2, ?, 2, ?)`
          ).run('job:job-1', 'job-1', '{}', now)
          db.prepare(
            `INSERT INTO control_outbox_events (
              topic, event_type, entity_id, aggregate_revision, payload_json, payload_bytes, created_at_ms
            ) VALUES (?, 'job.changed', ?, 2, ?, 2, ?)`
          ).run('job:job-2', 'job-2', '{}', now)
        }
      },
      async (ctx) => {
        await bootAuthoritativeRuntime(ctx)
        const actor = { username: 'u1', requestId: 'req-1' }
        const replay = getControlPlaneReplayEvents(ctx, actor, 0, 10)
        assert.equal(replay.length, 1)
        assert.equal(replay[0]?.entityId, 'job-1')
      }
    )
  })

  it('does not treat global id gaps as owner-stream loss in renderer reducer', () => {
    const reducer = new EventReducer()
    const seen: number[] = []
    reducer.registerHandler('job.changed', (event) => {
      seen.push(event.eventId)
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
      eventId: 4,
      topic: 'job:job-1',
      type: 'job.changed',
      entityId: 'job-1',
      revision: 2,
      payload: {}
    })

    assert.deepEqual(seen, [1, 4])
    assert.equal(reducer.getLastEventId(), 4)
  })

  it('flushes outbox to event hub after committed command', async () => {
    await withCompositionContext(
      {
        generation: 'v3_authoritative',
        seed(db) {
          seedControlJob(db, {
            jobId: 'job-1',
            username: 'u1',
            state: 'execution_running',
            stateRevision: 1,
            activeRunId: 'run-1'
          })
          db.prepare(
            `INSERT INTO control_job_runs (
              id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms
            ) VALUES ('run-1', 'job-1', 'execution', 'active', 1, 'fence-1', 0, ?)`
          ).run(Date.now())
        }
      },
      async (ctx) => {
        await bootAuthoritativeRuntime(ctx)
        const runtime = getControlPlaneRuntime(ctx)
        const received: number[] = []
        const unsubscribe = runtime.eventHub.subscribe('test', (event) => {
          received.push(event.eventId)
        })

        runtime.unitOfWork.transaction((tx) => {
          tx.outbox.appendOutbox({
            topic: 'job:job-1',
            eventType: 'job.changed',
            entityId: 'job-1',
            aggregateRevision: 2,
            createdAtMs: Date.now(),
            payload: {
              eventId: 0,
              topic: 'job:job-1',
              type: 'job.changed',
              entityId: 'job-1',
              revision: 2,
              changed: ['state']
            }
          })
        })

        await runtime.outboxDispatcher.flush()
        unsubscribe()
        assert.equal(received.length, 1)
      }
    )
  })
})
