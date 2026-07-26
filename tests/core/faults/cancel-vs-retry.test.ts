import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTestApplication } from '../../helpers/core/create-application.ts'
import { createJob } from '../../../src/server/core/domain/jobs/index.ts'
import {
  cancelJobWork,
  retryJobWork
} from '../../../src/server/core/application/workflows/job-control-work.ts'

describe('fault: cancel vs retry', () => {
  it('cancel wins over retry on cancelled job; retry on failed is distinct', async () => {
    const app = createTestApplication()
    await app.jobs.save(
      createJob({ id: 'job-cr', status: 'running', stateRevision: 1 })
    )

    const cancelled = await cancelJobWork(app, {
      jobId: 'job-cr',
      expectedRevision: 1,
      idempotencyKey: 'cancel',
      payloadHash: 'c',
      actorId: 'u'
    })
    assert.equal(cancelled.ok, true)
    if (!cancelled.ok) return

    // Retry is not allowed from cancelled in domain (only failed|verification)
    const retried = await retryJobWork(app, {
      jobId: 'job-cr',
      expectedRevision: cancelled.value.job.stateRevision,
      idempotencyKey: 'retry',
      payloadHash: 'r',
      actorId: 'u'
    })
    assert.equal(retried.ok, false)

    // Separate path: failed then retry works; cancel of already-cancelled is idempotent
    await app.jobs.save(
      createJob({ id: 'job-fr', status: 'failed', stateRevision: 3, executionGeneration: 1 })
    )
    const okRetry = await retryJobWork(app, {
      jobId: 'job-fr',
      expectedRevision: 3,
      idempotencyKey: 'retry-ok',
      payloadHash: 'ro',
      actorId: 'u'
    })
    assert.equal(okRetry.ok, true)
    if (!okRetry.ok) return
    assert.equal(okRetry.value.job.status, 'queued')

    // Duplicate cancel after cancel remains cancelled (no retry duplicate reopen)
    const dupCancel = await cancelJobWork(app, {
      jobId: 'job-cr',
      expectedRevision: cancelled.value.job.stateRevision,
      idempotencyKey: 'cancel-2',
      payloadHash: 'c2',
      actorId: 'u'
    })
    assert.equal(dupCancel.ok, true)
    if (!dupCancel.ok) return
    assert.equal(dupCancel.value.job.status, 'cancelled')
  })
})
