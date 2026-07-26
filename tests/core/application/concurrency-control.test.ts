import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createJob } from '../../../src/server/core/domain/jobs/index.ts'
import { pauseJobCommand } from '../../../src/server/core/application/commands/pause-job.ts'
import { cancelJobCommand } from '../../../src/server/core/application/commands/cancel-job.ts'
import { retryJobCommand } from '../../../src/server/core/application/commands/retry-job.ts'
import { createTestApplication } from '../../helpers/core/create-application.ts'

describe('concurrency control: pause / cancel / retry idempotent', () => {
  it('repeat pause on paused is ok and does not bump revision again', async () => {
    const app = createTestApplication()
    const job = createJob({ id: 'job-pause', status: 'queued', stateRevision: 1 })
    await app.jobs.save(job)

    const first = await pauseJobCommand(app, {
      jobId: 'job-pause',
      expectedRevision: 1,
      idempotencyKey: 'pause-a',
      payloadHash: 'p1',
      actorId: 'user-1'
    })
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.value.job.status, 'paused')
    assert.equal(first.value.job.stateRevision, 2)

    const second = await pauseJobCommand(app, {
      jobId: 'job-pause',
      expectedRevision: 2,
      idempotencyKey: 'pause-b',
      payloadHash: 'p2',
      actorId: 'user-1'
    })
    assert.equal(second.ok, true)
    if (!second.ok) return
    assert.equal(second.value.job.status, 'paused')
    assert.equal(second.value.job.stateRevision, 2)
  })

  it('repeat cancel on cancelled is idempotent', async () => {
    const app = createTestApplication()
    await app.jobs.save(createJob({ id: 'job-cancel', status: 'running', stateRevision: 3 }))

    const first = await cancelJobCommand(app, {
      jobId: 'job-cancel',
      expectedRevision: 3,
      idempotencyKey: 'cancel-a',
      payloadHash: 'c1',
      actorId: 'user-1'
    })
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.value.job.status, 'cancelled')

    const second = await cancelJobCommand(app, {
      jobId: 'job-cancel',
      expectedRevision: first.value.job.stateRevision,
      idempotencyKey: 'cancel-b',
      payloadHash: 'c2',
      actorId: 'user-1'
    })
    assert.equal(second.ok, true)
    if (!second.ok) return
    assert.equal(second.value.job.status, 'cancelled')
    assert.equal(second.value.job.stateRevision, first.value.job.stateRevision)
  })

  it('repeat retry when already queued is idempotent and does not bump generation', async () => {
    const app = createTestApplication()
    await app.jobs.save(
      createJob({
        id: 'job-retry',
        status: 'failed',
        stateRevision: 2,
        executionGeneration: 1
      })
    )

    const first = await retryJobCommand(app, {
      jobId: 'job-retry',
      expectedRevision: 2,
      idempotencyKey: 'retry-a',
      payloadHash: 'r1',
      actorId: 'user-1'
    })
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.value.job.status, 'queued')
    assert.equal(first.value.job.executionGeneration, 2)

    const second = await retryJobCommand(app, {
      jobId: 'job-retry',
      expectedRevision: first.value.job.stateRevision,
      idempotencyKey: 'retry-b',
      payloadHash: 'r2',
      actorId: 'user-1'
    })
    assert.equal(second.ok, true)
    if (!second.ok) return
    assert.equal(second.value.job.status, 'queued')
    assert.equal(second.value.job.executionGeneration, 2)
    assert.equal(second.value.job.stateRevision, first.value.job.stateRevision)
  })
})
