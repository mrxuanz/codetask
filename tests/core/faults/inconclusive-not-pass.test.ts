import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createTestApplication,
  seedJobGraph
} from '../../helpers/core/create-application.ts'
import { executeTaskWork } from '../../../src/server/core/application/workflows/execute-task-work.ts'
import { verifyWork } from '../../../src/server/core/application/workflows/verify-work.ts'
import {
  assertNotForgingCompleted,
  decideJobCompletion,
  remapVerdict
} from '../../../src/server/core/domain/verification/index.ts'

describe('fault: inconclusive must not pass', () => {
  it('provider inconclusive does not complete the task', async () => {
    const app = createTestApplication()
    app.fakeProvider.setBehavior({ mode: 'inconclusive' })
    const { job, workspaceId } = await seedJobGraph(app, {
      jobId: 'job-inc',
      tasks: [{ id: 't1' }]
    })

    const result = await executeTaskWork(app, {
      jobId: job.id,
      workspaceId,
      taskId: 't1'
    })
    assert.equal(result.outcome.kind, 'inconclusive')
    assert.equal(result.checkpoint.kind, 'inconclusive')
    assert.equal(result.attempt.status, 'inconclusive')
    const task = await app.tasks.get(job.id, 1, 't1')
    assert.notEqual(task?.status, 'completed')
  })

  it('verification inconclusive blocks job completion', async () => {
    const app = createTestApplication()
    const { job, workspaceId } = await seedJobGraph(app, {
      jobId: 'job-inc-v',
      tasks: [{ id: 't1' }]
    })
    await executeTaskWork(app, { jobId: job.id, workspaceId, taskId: 't1' })

    const verified = await verifyWork(app, {
      kind: 'milestone',
      jobId: job.id,
      scopeId: 'm1',
      evaluate: () => ({
        verdict: 'inconclusive',
        summary: 'unclear',
        evidenceRefs: [],
        findings: []
      })
    })
    assert.equal(verified.decision.kind, 'block_inconclusive')
    assert.notEqual(verified.job.status, 'completed')
    assert.equal(verified.attempt.result?.verdict, 'inconclusive')
  })

  it('domain guards reject inconclusive→pass forge', () => {
    assert.deepEqual(decideJobCompletion('inconclusive'), {
      kind: 'block_inconclusive'
    })
    assert.equal(assertNotForgingCompleted('inconclusive').ok, false)
    assert.equal(remapVerdict('inconclusive', 'pass').ok, false)
  })
})
