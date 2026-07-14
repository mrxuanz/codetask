import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import { threadJobs, threadMessages, threads, projects } from '../../src/server/db/schema'
import { resetJobReconcileForTests, stopWorkloadReconcilerForTests } from '../../src/server/legacy-control-plane/reconcile'
import { ensureStartupWorkloadReady } from '../../src/server/legacy-control-plane/workload-slot'
import {
  claimWorkloadSlotTx,
  getActiveRun,
  resetWorkloadRunControllersForTests
} from '../../src/server/legacy-control-plane/workload-slot-store'
import {
  finishExecutionRunLifecycle,
  finishPlanningRunLifecycle,
  stopRunLifecycle
} from '../../src/server/legacy-control-plane/run-lifecycle'
import {
  hasRunRuntime,
  registerRunRuntime,
  resetRuntimeSupervisorForTests
} from '../../src/server/legacy-control-plane/runtime-supervisor'
import { workloadRuns } from '../../src/server/db/schema'
import { eq } from 'drizzle-orm'

let dataDir: string

async function setupDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-run-lifecycle-'))
  process.env.CODETASK_RUN_CANCEL_GRACE_MS = '0'
  process.env.CODETASK_RUN_KILL_GRACE_MS = '0'
  await resetAppContextForTests()
  resetJobReconcileForTests()
  bootstrapRuntime({ dataDir })
  await ensureStartupWorkloadReady()
  stopWorkloadReconcilerForTests()
}

async function teardownDb(): Promise<void> {
  resetWorkloadRunControllersForTests()
  resetRuntimeSupervisorForTests()
  await resetAppContextForTests()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

async function seedJob(jobId: string): Promise<void> {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const projectId = `proj-${jobId}`
  const threadId = `thread-${jobId}`
  const draftId = `draft-${jobId}`

  await db.insert(projects).values({
    id: projectId,
    username: 'user',
    title: 'P',
    workspaceRoot: `/tmp/ws-${jobId}`,
    createdAt: now,
    updatedAt: now
  })
  await db.insert(threads).values({
    id: threadId,
    username: 'user',
    projectId,
    title: 'T',
    status: 'draft',
    conversationId: 'conv-1',
    coreCode: 'cursor',
    runtimeStatus: 'idle',
    coreRuntimeJson: '{}',
    createdAt: now,
    updatedAt: now
  })
  await db.insert(threadMessages).values({
    id: draftId,
    threadId,
    username: 'user',
    role: 'assistant',
    kind: 'task-launch-draft',
    content: '{}',
    coreCode: 'cursor',
    conversationId: 'conv-1',
    createdAt: String(now)
  })
  await db.insert(threadJobs).values({
    id: jobId,
    threadId,
    username: 'user',
    draftMessageId: draftId,
    title: 'Test',
    summary: '',
    status: 'planning',
    workspacePath: '/tmp/ws',
    createdAt: now,
    updatedAt: now
  })
}

test('finishPlanningRunLifecycle success closes and releases slot', async () => {
  await setupDb()
  try {
    await seedJob('job-1')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(run)

    let closed = false
    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {
        closed = true
      }
    })

    await finishPlanningRunLifecycle(run.runId, 'planning_done', 'success')
    assert.equal(closed, true)
    assert.equal(await getActiveRun('thread_job', 'job-1'), null)
  } finally {
  await teardownDb()
  }
})

test('finishPlanningRunLifecycle failure runs stop lifecycle with injectable deps', async () => {
  await setupDb()
  try {
    await seedJob('job-1')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(run)

    const events: string[] = []
    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      cancel: async () => {
        events.push('cancel')
      },
      close: async () => {
        events.push('close')
      },
      kill: async () => {
        events.push('kill')
      },
      waitClosed: async () => {
        events.push('waitClosed')
      }
    })

    await stopRunLifecycle(run.runId, 'timeout', {
      cancelRun: async () => {
        events.push('cancel')
      },
      stopRun: async () => {
        events.push('close')
      },
      hardKill: async () => {
        events.push('kill')
      },
      waitClosed: async () => {
        events.push('waitClosed')
      },
      sleep: async () => {}
    })

    assert.deepEqual(events, ['cancel', 'close', 'kill', 'waitClosed', 'close'])
    assert.equal(await getActiveRun('thread_job', 'job-1'), null)
  } finally {
  await teardownDb()
  }
})

test('stopRunLifecycle skipRelease keeps slot until explicit release', async () => {
  await setupDb()
  try {
    await seedJob('job-1')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(run)

    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {}
    })

    await stopRunLifecycle(run.runId, 'timeout', { sleep: async () => {} }, { skipRelease: true })
    assert.notEqual(await getActiveRun('thread_job', 'job-1'), null)
  } finally {
  await teardownDb()
  }
})

test('finishExecutionRunLifecycle success closes runtime before releasing slot', async () => {
  await setupDb()
  try {
    await seedJob('job-exec')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-exec',
      kind: 'execution'
    })
    assert.ok(run)

    let closed = false
    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {
        closed = true
      }
    })

    await finishExecutionRunLifecycle(
      run.runId,
      {
        username: 'user',
        jobId: 'job-exec',
        reason: 'execution_done',
        outcome: 'success'
      },
      { finalizeExecution: async () => {} }
    )
    assert.equal(closed, true)
    assert.equal(await getActiveRun('thread_job', 'job-exec'), null)
  } finally {
  await teardownDb()
  }
})

test('finishExecutionRunLifecycle failure runs stop lifecycle before release', async () => {
  await setupDb()
  try {
    await seedJob('job-exec-fail')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-exec-fail',
      kind: 'execution'
    })
    assert.ok(run)

    const events: string[] = []
    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      cancel: async () => {
        events.push('cancel')
      },
      close: async () => {
        events.push('close')
      },
      kill: async () => {
        events.push('kill')
      },
      waitClosed: async () => {
        events.push('waitClosed')
      }
    })

    await finishExecutionRunLifecycle(
      run.runId,
      {
        username: 'user',
        jobId: 'job-exec-fail',
        reason: 'execution_failed',
        outcome: 'failure'
      },
      {
        cancelRun: async () => {
          events.push('cancelRun')
        },
        stopRun: async () => {
          events.push('stopRun')
        },
        hardKill: async () => {
          events.push('hardKill')
        },
        waitClosed: async () => {
          events.push('waitClosedHook')
        },
        sleep: async () => {},
        finalizeExecution: async () => {}
      }
    )

    assert.deepEqual(events, [
      'cancelRun',
      'stopRun',
      'hardKill',
      'waitClosedHook',
      'close'
    ])
    assert.equal(await getActiveRun('thread_job', 'job-exec-fail'), null)
  } finally {
  await teardownDb()
  }
})

test('finishPlanningRunLifecycle skips release when run already released', async () => {
  await setupDb()
  try {
    await seedJob('job-1')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(run)

    let closeCalls = 0
    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {
        closeCalls += 1
      }
    })

    await finishPlanningRunLifecycle(run.runId, 'planning_done', 'success')
    assert.equal(await getActiveRun('thread_job', 'job-1'), null)

    await finishPlanningRunLifecycle(run.runId, 'planning_done', 'failure')
    assert.equal(closeCalls, 1)
  } finally {
  await teardownDb()
  }
})

test('stopRunLifecycle keeps slot when waitClosed rejects', async () => {
  await setupDb()
  try {
    await seedJob('job-wait-fail')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-wait-fail',
      kind: 'planning'
    })
    assert.ok(run)

    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {}
    })

    await assert.rejects(
      () =>
        stopRunLifecycle(run.runId, 'timeout', {
          sleep: async () => {},
          waitClosed: async () => {
            throw new Error('waitClosed rejected')
          }
        }),
      /waitClosed rejected/
    )

    const active = await getActiveRun('thread_job', 'job-wait-fail')
    assert.ok(active)
    assert.equal(active.status, 'stopping')
    assert.equal(hasRunRuntime(run.runId), true)

    const [runRow] = await getDb()
      .select()
      .from(workloadRuns)
      .where(eq(workloadRuns.id, run.runId))
    assert.ok(runRow)
    assert.equal(runRow.status, 'stopping')
    assert.match(runRow.cancelReason ?? '', /child_close_unconfirmed/)
  } finally {
    await teardownDb()
  }
})

test('stopRunLifecycle keeps slot when waitClosed never resolves', async () => {
  await setupDb()
  try {
    await seedJob('job-wait-hang')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-wait-hang',
      kind: 'planning'
    })
    assert.ok(run)

    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {},
      waitClosed: async () => new Promise(() => {})
    })

    await assert.rejects(
      () =>
        stopRunLifecycle(run.runId, 'timeout', {
          sleep: async () => {},
          waitClosed: async () =>
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error(`waitClosed timeout for ${run.runId}`)), 10)
            })
        }),
      /waitClosed timeout/
    )

    assert.notEqual(await getActiveRun('thread_job', 'job-wait-hang'), null)
    assert.equal(hasRunRuntime(run.runId), true)
  } finally {
    await teardownDb()
  }
})

test('stopRunLifecycle keeps slot when hardKill throws and waitClosed fails', async () => {
  await setupDb()
  try {
    await seedJob('job-kill-wait-fail')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-kill-wait-fail',
      kind: 'planning'
    })
    assert.ok(run)

    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {}
    })

    await assert.rejects(
      () =>
        stopRunLifecycle(run.runId, 'timeout', {
          sleep: async () => {},
          hardKill: async () => {
            throw new Error('hardKill failed')
          },
          waitClosed: async () => {
            throw new Error('waitClosed failed')
          }
        }),
      /waitClosed failed/
    )

    const active = await getActiveRun('thread_job', 'job-kill-wait-fail')
    assert.ok(active)
    assert.equal(active.status, 'stopping')
    assert.equal(hasRunRuntime(run.runId), true)
  } finally {
    await teardownDb()
  }
})

test('stopRunLifecycle releases slot after waitClosed confirms closed', async () => {
  await setupDb()
  try {
    await seedJob('job-stop-success')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-stop-success',
      kind: 'planning'
    })
    assert.ok(run)

    let waitClosedCalled = false
    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {},
      waitClosed: async () => {
        waitClosedCalled = true
      }
    })

    await stopRunLifecycle(run.runId, 'timeout', {
      sleep: async () => {},
      waitClosed: async () => {
        waitClosedCalled = true
      }
    })

    assert.equal(waitClosedCalled, true)
    assert.equal(await getActiveRun('thread_job', 'job-stop-success'), null)
    assert.equal(hasRunRuntime(run.runId), false)
  } finally {
    await teardownDb()
  }
})
