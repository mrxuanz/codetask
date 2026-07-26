import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createTestApplication,
  seedJobGraph
} from '../../helpers/core/create-application.ts'
import { executeTaskWork } from '../../../src/server/core/application/workflows/execute-task-work.ts'

describe('fault: crash after commit before outbox publish', () => {
  it('durable checkpoint survives; undrained outbox can be published later', async () => {
    const app = createTestApplication()
    app.unitOfWork.autoDrain = false
    const { job, workspaceId } = await seedJobGraph(app, {
      jobId: 'job-crash-post',
      tasks: [{ id: 't1' }]
    })

    const result = await executeTaskWork(app, {
      jobId: job.id,
      workspaceId,
      taskId: 't1'
    })
    assert.equal(result.checkpoint.kind, 'succeeded')

    // Committed but not published (simulate crash before outbox drain)
    assert.ok(app.unitOfWork.outbox.length > 0)
    assert.equal(app.eventPublisher.published.length, 0)

    const attempt = await app.attempts.get(result.attempt.id)
    assert.equal(attempt?.status, 'succeeded')

    // Recovery: drain outbox
    app.unitOfWork.autoDrain = true
    const drained = await app.unitOfWork.drainOutbox()
    assert.ok(drained > 0)
    assert.ok(app.eventPublisher.published.length > 0)
    assert.equal(app.unitOfWork.outbox.length, 0)
  })
})
