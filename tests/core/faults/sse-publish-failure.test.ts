import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createTestApplication,
  seedJobGraph
} from '../../helpers/core/create-application.ts'
import { executeTaskWork } from '../../../src/server/core/application/workflows/execute-task-work.ts'

describe('fault: SSE publish failure', () => {
  it('keeps durable checkpoint when SSE/outbox publish fails; drain retries', async () => {
    const app = createTestApplication()
    app.unitOfWork.autoDrain = false

    const { job, workspaceId } = await seedJobGraph(app, {
      jobId: 'job-sse',
      tasks: [{ id: 't1' }]
    })

    const result = await executeTaskWork(app, {
      jobId: job.id,
      workspaceId,
      taskId: 't1'
    })
    assert.equal(result.checkpoint.kind, 'succeeded')
    assert.ok(app.unitOfWork.outbox.length > 0)

    app.unitOfWork.publishFault = new Error('sse.publish_failed')
    await assert.rejects(() => app.unitOfWork.drainOutbox(), /sse\.publish_failed/)

    // Durable state intact
    const attempt = await app.attempts.get(result.attempt.id)
    assert.equal(attempt?.status, 'succeeded')
    assert.ok(app.unitOfWork.outbox.length > 0)

    // Recovery: clear SSE fault and drain
    app.unitOfWork.publishFault = null
    const drained = await app.unitOfWork.drainOutbox()
    assert.ok(drained > 0)
    assert.equal(app.unitOfWork.outbox.length, 0)
    assert.ok(app.eventPublisher.published.length > 0)
  })
})
