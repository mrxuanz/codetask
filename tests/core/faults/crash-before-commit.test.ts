import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createTestApplication,
  seedJobGraph
} from '../../helpers/core/create-application.ts'
import { executeTaskWork } from '../../../src/server/core/application/workflows/execute-task-work.ts'

describe('fault: crash before DB commit', () => {
  it('provider success then crash before checkpoint leaves attempt non-succeeded', async () => {
    const app = createTestApplication()
    const { job, workspaceId } = await seedJobGraph(app, {
      jobId: 'job-crash-pre',
      tasks: [{ id: 't1' }]
    })

    await assert.rejects(
      () =>
        executeTaskWork(app, {
          jobId: job.id,
          workspaceId,
          taskId: 't1',
          faults: {
            beforeCommit: () => {
              throw new Error('injected.crash_before_commit')
            }
          }
        }),
      /crash_before_commit/
    )

    const attempts = await app.attempts.listForTask(job.id, 't1', 1)
    assert.ok(attempts.length >= 1)
    const latest = attempts[attempts.length - 1]!
    assert.notEqual(latest.status, 'succeeded')
    assert.equal(latest.status, 'running')

    const task = await app.tasks.get(job.id, 1, 't1')
    assert.notEqual(task?.status, 'completed')
  })
})
