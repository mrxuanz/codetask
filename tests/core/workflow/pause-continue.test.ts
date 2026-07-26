import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createTestApplication,
  seedJobGraph
} from '../../helpers/core/create-application.ts'
import {
  pauseJobWork,
  continueJobWork
} from '../../../src/server/core/application/workflows/job-control-work.ts'
import { executeTaskWork } from '../../../src/server/core/application/workflows/execute-task-work.ts'

describe('pause / continue workflow', () => {
  it('pauses a queued job and continues back to queued idempotently', async () => {
    const app = createTestApplication()
    const { job } = await seedJobGraph(app, {
      jobId: 'job-pc',
      tasks: [{ id: 't1' }]
    })

    const paused = await pauseJobWork(app, {
      jobId: job.id,
      expectedRevision: 0,
      idempotencyKey: 'pause-1',
      payloadHash: 'p1',
      actorId: 'u1'
    })
    assert.equal(paused.ok, true)
    if (!paused.ok) return
    assert.equal(paused.value.job.status, 'paused')

    const again = await pauseJobWork(app, {
      jobId: job.id,
      expectedRevision: paused.value.job.stateRevision,
      idempotencyKey: 'pause-2',
      payloadHash: 'p2',
      actorId: 'u1'
    })
    assert.equal(again.ok, true)
    if (!again.ok) return
    assert.equal(again.value.job.stateRevision, paused.value.job.stateRevision)

    const continued = await continueJobWork(app, {
      jobId: job.id,
      expectedRevision: again.value.job.stateRevision,
      idempotencyKey: 'cont-1',
      payloadHash: 'c1',
      actorId: 'u1'
    })
    assert.equal(continued.ok, true)
    if (!continued.ok) return
    assert.equal(continued.value.job.status, 'queued')
  })

  it('blocks execute while paused', async () => {
    const app = createTestApplication()
    const { job, workspaceId } = await seedJobGraph(app, {
      jobId: 'job-block',
      tasks: [{ id: 't1' }]
    })
    await pauseJobWork(app, {
      jobId: job.id,
      expectedRevision: 0,
      idempotencyKey: 'p',
      payloadHash: 'p',
      actorId: 'u'
    })

    await assert.rejects(
      () =>
        executeTaskWork(app, {
          jobId: job.id,
          workspaceId,
          taskId: 't1'
        }),
      /paused/
    )
  })
})
