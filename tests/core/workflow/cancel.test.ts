import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createTestApplication,
  seedJobGraph
} from '../../helpers/core/create-application.ts'
import { cancelJobWork } from '../../../src/server/core/application/workflows/job-control-work.ts'
import { executeTaskWork } from '../../../src/server/core/application/workflows/execute-task-work.ts'

describe('cancel workflow', () => {
  it('cancels a running job idempotently and releases leases', async () => {
    const app = createTestApplication()
    const { job, workspaceId } = await seedJobGraph(app, {
      jobId: 'job-cancel',
      status: 'running',
      tasks: [{ id: 't1' }]
    })
    await app.leases.tryAcquire({
      workspaceId,
      holderId: job.id,
      acquiredAtMs: 1
    })

    const first = await cancelJobWork(app, {
      jobId: job.id,
      expectedRevision: 0,
      idempotencyKey: 'cancel-1',
      payloadHash: 'c1',
      actorId: 'u1'
    })
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.value.job.status, 'cancelled')
    assert.equal(await app.leases.get(workspaceId), undefined)

    const second = await cancelJobWork(app, {
      jobId: job.id,
      expectedRevision: first.value.job.stateRevision,
      idempotencyKey: 'cancel-2',
      payloadHash: 'c2',
      actorId: 'u1'
    })
    assert.equal(second.ok, true)
    if (!second.ok) return
    assert.equal(second.value.job.status, 'cancelled')
    assert.equal(second.value.job.stateRevision, first.value.job.stateRevision)
  })

  it('rejects execute after cancel', async () => {
    const app = createTestApplication()
    const { job, workspaceId } = await seedJobGraph(app, {
      jobId: 'job-cx',
      tasks: [{ id: 't1' }]
    })
    await cancelJobWork(app, {
      jobId: job.id,
      expectedRevision: 0,
      idempotencyKey: 'c',
      payloadHash: 'c',
      actorId: 'u'
    })
    await assert.rejects(
      () =>
        executeTaskWork(app, {
          jobId: job.id,
          workspaceId,
          taskId: 't1'
        }),
      /cancelled/
    )
  })
})
