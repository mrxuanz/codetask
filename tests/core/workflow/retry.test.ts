import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createTestApplication,
  seedJobGraph
} from '../../helpers/core/create-application.ts'
import { retryJobWork } from '../../../src/server/core/application/workflows/job-control-work.ts'
import { createJob } from '../../../src/server/core/domain/jobs/index.ts'

describe('retry workflow', () => {
  it('retries failed job into queued and bumps executionGeneration', async () => {
    const app = createTestApplication()
    await app.jobs.save(
      createJob({
        id: 'job-retry',
        status: 'failed',
        stateRevision: 2,
        executionGeneration: 1
      })
    )

    const first = await retryJobWork(app, {
      jobId: 'job-retry',
      expectedRevision: 2,
      idempotencyKey: 'retry-1',
      payloadHash: 'r1',
      actorId: 'u1'
    })
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.value.job.status, 'queued')
    assert.equal(first.value.job.executionGeneration, 2)

    const second = await retryJobWork(app, {
      jobId: 'job-retry',
      expectedRevision: first.value.job.stateRevision,
      idempotencyKey: 'retry-2',
      payloadHash: 'r2',
      actorId: 'u1'
    })
    assert.equal(second.ok, true)
    if (!second.ok) return
    assert.equal(second.value.job.executionGeneration, 2)
    assert.equal(second.value.job.stateRevision, first.value.job.stateRevision)
  })

  it('seeded graph remains usable after retry generation bump', async () => {
    const app = createTestApplication()
    const { job } = await seedJobGraph(app, {
      jobId: 'job-retry-graph',
      status: 'failed',
      tasks: [{ id: 't1' }]
    })
    // Force failed with revision from seed (0 → need save)
    await app.jobs.save({ ...job, status: 'failed', stateRevision: 1 })

    const retried = await retryJobWork(app, {
      jobId: job.id,
      expectedRevision: 1,
      idempotencyKey: 'rg',
      payloadHash: 'rg',
      actorId: 'u'
    })
    assert.equal(retried.ok, true)
    if (!retried.ok) return
    assert.equal(retried.value.job.executionGeneration, job.executionGeneration + 1)
  })
})
