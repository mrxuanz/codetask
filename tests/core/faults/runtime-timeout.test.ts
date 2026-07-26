import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createTestApplication,
  seedJobGraph
} from '../../helpers/core/create-application.ts'
import { executeTaskWork } from '../../../src/server/core/application/workflows/execute-task-work.ts'

describe('fault: runtime timeout', () => {
  it('maps provider hang + timeoutMs to failed timeout checkpoint', async () => {
    const app = createTestApplication()
    app.fakeProvider.setBehavior({ mode: 'hang' })
    const { job, workspaceId } = await seedJobGraph(app, {
      jobId: 'job-timeout',
      tasks: [{ id: 't1' }]
    })

    const result = await executeTaskWork(app, {
      jobId: job.id,
      workspaceId,
      taskId: 't1',
      timeoutMs: 20
    })

    assert.equal(result.outcome.kind, 'timeout')
    assert.equal(result.checkpoint.kind, 'failed')
    if (result.checkpoint.kind === 'failed') {
      assert.equal(result.checkpoint.attempt.errorCode, 'runtime.timeout')
    }
    const finalJob = await app.jobs.get(job.id)
    assert.equal(finalJob?.status, 'failed')
  })
})
