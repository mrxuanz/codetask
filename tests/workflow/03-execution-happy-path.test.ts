import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { WorkflowHarness } from '../helpers/workflow-harness'

describe('03 execution happy path', () => {
  const harness = new WorkflowHarness()

  before(async () => {
    await harness.setup()
  })

  after(async () => {
    await harness.teardown()
  })

  it('completes three tasks with slice and milestone verification', async () => {
    const job = await harness.runHappyPathExecution()
    assert.equal(job.status, 'completed')

    const progress = job.taskProgress as {
      tasks?: Array<{ id: string; evidenceStatus?: string | null }>
      slices?: Array<{ id: string; runtimeStatus?: string; verificationStatus?: string | null }>
      milestones?: Array<{ id: string; verificationStatus?: string | null }>
    }

    for (const taskId of ['m1-s1-t1', 'm1-s2-t1', 'm1-s2-t2']) {
      const task = progress.tasks?.find((item) => item.id === taskId)
      assert.ok(task?.evidenceStatus, `missing evidence for ${taskId}`)
    }

    const slice1 = progress.slices?.find((item) => item.id === 'm1-s1')
    const slice2 = progress.slices?.find((item) => item.id === 'm1-s2')
    assert.equal(slice1?.runtimeStatus, 'progress-ok')
    assert.equal(slice2?.runtimeStatus, 'progress-ok')
    assert.equal(progress.milestones?.[0]?.verificationStatus, 'passed')

    for (const taskId of ['m1-s1-t1', 'm1-s2-t1', 'm1-s2-t2']) {
      const runtimeRoot = join(
        harness.dataDir,
        'runtimes',
        String(job.threadId),
        'jobs',
        String(job.id),
        'tasks',
        taskId
      )
      const other = taskId === 'm1-s1-t1' ? 'm1-s2-t1' : 'm1-s1-t1'
      const otherRoot = join(
        harness.dataDir,
        'runtimes',
        String(job.threadId),
        'jobs',
        String(job.id),
        'tasks',
        other
      )
      assert.notEqual(runtimeRoot, otherRoot)
    }
  })
})
