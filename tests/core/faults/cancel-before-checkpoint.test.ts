import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createTestApplication,
  seedJobGraph
} from '../../helpers/core/create-application.ts'
import { executeTaskWork } from '../../../src/server/core/application/workflows/execute-task-work.ts'
import { cancelJobWork } from '../../../src/server/core/application/workflows/job-control-work.ts'

describe('fault: cancel before checkpoint', () => {
  it('provider result then cancel before checkpoint does not complete task', async () => {
    const app = createTestApplication()
    const { job, workspaceId } = await seedJobGraph(app, {
      jobId: 'job-cancel-ckpt',
      tasks: [{ id: 't1' }]
    })

    const result = await executeTaskWork(app, {
      jobId: job.id,
      workspaceId,
      taskId: 't1',
      faults: {
        afterProviderBeforeCheckpoint: async () => {
          const live = await app.jobs.get(job.id)
          await cancelJobWork(app, {
            jobId: job.id,
            expectedRevision: live!.stateRevision,
            idempotencyKey: 'cancel-race',
            payloadHash: 'cr',
            actorId: 'u'
          })
        }
      }
    })

    assert.equal(result.outcome.kind, 'succeeded')
    assert.equal(result.checkpoint.kind, 'aborted_by_control')
    if (result.checkpoint.kind === 'aborted_by_control') {
      assert.equal(result.checkpoint.reason, 'cancelled')
    }

    const task = await app.tasks.get(job.id, 1, 't1')
    assert.notEqual(task?.status, 'completed')
    const finalJob = await app.jobs.get(job.id)
    assert.equal(finalJob?.status, 'cancelled')
  })
})
