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
import { registerRunRuntime, resetRuntimeSupervisorForTests } from '../../src/server/legacy-control-plane/runtime-supervisor'

let dataDir: string

async function setupDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-run-lifecycle-'))
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
