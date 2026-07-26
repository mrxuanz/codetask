import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createTestApplication,
  seedJobGraph
} from '../../helpers/core/create-application.ts'
import { selectReadyTasks } from '../../../src/server/core/application/workflows/scheduler.ts'
import { executeTaskWork } from '../../../src/server/core/application/workflows/execute-task-work.ts'
import { verifyWork } from '../../../src/server/core/application/workflows/verify-work.ts'
import { retentionWork } from '../../../src/server/core/application/workflows/retention-work.ts'
import { startupReconcile } from '../../../src/server/core/application/workflows/startup-reconcile.ts'

describe('fake provider full job workflow', () => {
  it('runs selectReady → execute → verify → complete without legacy executor', async () => {
    const app = createTestApplication()
    const { job, workspaceId } = await seedJobGraph(app, {
      jobId: 'job-full',
      tasks: [
        { id: 't1', title: 'First', sliceId: 's1', milestoneId: 'm1' },
        {
          id: 't2',
          title: 'Second',
          dependencyIds: ['t1'],
          sliceId: 's1',
          milestoneId: 'm1'
        }
      ]
    })

    // First wave: only t1 ready
    let projection = await app.tasks.listForJob(job.id, job.executionGeneration)
    let ready = await selectReadyTasks({
      jobId: job.id,
      workspaceId,
      tasks: projection,
      leases: app.leases,
      nowMs: app.clock.now().getTime()
    })
    assert.deepEqual(
      ready.ready.map((t) => t.task.id),
      ['t1']
    )

    const r1 = await executeTaskWork(app, {
      jobId: job.id,
      workspaceId,
      taskId: 't1',
      providerCode: 'fake'
    })
    assert.equal(r1.checkpoint.kind, 'succeeded')
    assert.equal(r1.attempt.status, 'succeeded')
    assert.ok(app.fakeProvider.executeCalls.length >= 1)

    // Second wave: t2 ready after t1
    projection = await app.tasks.listForJob(job.id, 1)
    ready = await selectReadyTasks({
      jobId: job.id,
      workspaceId,
      tasks: projection,
      leases: app.leases,
      nowMs: app.clock.now().getTime()
    })
    assert.deepEqual(
      ready.ready.map((t) => t.task.id),
      ['t2']
    )

    const r2 = await executeTaskWork(app, {
      jobId: job.id,
      workspaceId,
      taskId: 't2',
      providerCode: 'fake'
    })
    assert.equal(r2.checkpoint.kind, 'succeeded')

    const verified = await verifyWork(app, {
      kind: 'slice',
      jobId: job.id,
      scopeId: 's1',
      evaluate: () => ({
        verdict: 'pass',
        summary: 'all tasks ok',
        evidenceRefs: ['e1'],
        findings: []
      })
    })
    assert.equal(verified.decision.kind, 'complete')
    assert.equal(verified.job.status, 'completed')
    assert.equal(verified.attempt.result?.verdict, 'pass')

    // No legacy executor imports — Fake Provider only
    assert.equal(app.fakeProvider.code, 'fake')
  })

  it('enforces workspace single-writer in scheduler', async () => {
    const app = createTestApplication()
    const a = await seedJobGraph(app, {
      jobId: 'job-a',
      workspaceId: 'shared-ws',
      tasks: [{ id: 'ta' }]
    })
    await seedJobGraph(app, {
      jobId: 'job-b',
      workspaceId: 'shared-ws',
      tasks: [{ id: 'tb' }]
    })

    const tasksA = await app.tasks.listForJob(a.job.id, 1)
    await selectReadyTasks({
      jobId: 'job-a',
      workspaceId: 'shared-ws',
      tasks: tasksA,
      leases: app.leases,
      nowMs: 1
    })

    const tasksB = await app.tasks.listForJob('job-b', 1)
    await assert.rejects(
      () =>
        selectReadyTasks({
          jobId: 'job-b',
          workspaceId: 'shared-ws',
          tasks: tasksB,
          leases: app.leases,
          nowMs: 2
        }),
      /single_writer/
    )
  })

  it('retention work deletes eligible artifacts', async () => {
    const app = createTestApplication()
    await app.retention.save({
      id: 'art-1',
      kind: 'raw_output',
      expiresAtMs: 1,
      deletedAtMs: null
    })
    await app.retention.save({
      id: 'art-2',
      kind: 'transient',
      expiresAtMs: Date.parse('2099-01-01'),
      deletedAtMs: null
    })

    const result = await retentionWork(app, { nowMs: 100 })
    assert.equal(result.deletedCount, 1)
    assert.deepEqual(result.deletedIds, ['art-1'])
    const gone = await app.retention.get('art-1')
    assert.ok(gone?.deletedAtMs != null)
  })

  it('startup reconcile clears stale leases and never marks success from missing process', async () => {
    const app = createTestApplication()
    const { job } = await seedJobGraph(app, {
      jobId: 'job-orphan',
      status: 'running',
      tasks: [{ id: 't1' }]
    })
    await app.leases.tryAcquire({
      workspaceId: 'ws-orphan',
      holderId: job.id,
      acquiredAtMs: 0
    })
    await app.attempts.save(
      {
        id: 'att-1',
        taskId: 't1' as import('../../../src/server/core/domain/tasks/types.ts').TaskId,
        executionGeneration: 1,
        status: 'running',
        idempotencyKey: 'k',
        resultHash: null,
        errorCode: null
      },
      { jobId: job.id }
    )

    const result = await startupReconcile(app, {
      jobs: [(await app.jobs.get(job.id))!],
      processPresence: [{ jobId: job.id, processAlive: false }],
      leaseMaxAgeMs: 1
    })

    assert.equal(result.markedSuccessFromMissingProcess, false)
    assert.ok(result.interruptedAttempts >= 1)
    const attempt = await app.attempts.get('att-1')
    assert.notEqual(attempt?.status, 'succeeded')
    assert.equal(attempt?.status, 'inconclusive')
    const updated = await app.jobs.get(job.id)
    assert.equal(updated?.status, 'failed')
    assert.equal(await app.leases.get('ws-orphan'), undefined)
  })
})
