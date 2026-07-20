import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import {
  projects,
  threadJobs,
  threadMessages,
  threads,
  workloadRuns,
  workspaceLeases
} from '../../src/server/db/schema'
import {
  resetJobReconcileForTests,
  stopWorkloadReconcilerForTests
} from '../../src/server/legacy-control-plane/reconcile'
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
  acquireWorkspaceLease,
  releaseWorkspaceLeaseForOwner
} from '../../src/server/legacy-control-plane/workspace-lease-store'
import {
  hasRunRuntime,
  registerRunRuntime,
  resetRuntimeSupervisorForTests
} from '../../src/server/legacy-control-plane/runtime-supervisor'
import { eq } from 'drizzle-orm'

let dataDir: string

async function setupDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-run-lifecycle-'))
  await resetAppContextForTests()
  resetJobReconcileForTests()
  bootstrapRuntime({
    dataDir,
    config: {
      execution: {
        runLifecycle: { cancelGraceMs: 0, killGraceMs: 0 }
      }
    }
  })
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

async function activeWorkspaceLeaseCount(): Promise<number> {
  const rows = await getDb()
    .select({ id: workspaceLeases.id })
    .from(workspaceLeases)
    .where(eq(workspaceLeases.status, 'active'))
  return rows.length
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

    const lease = acquireWorkspaceLease({
      workspacePath: '/tmp/ws',
      ownerKind: 'thread_job',
      ownerId: 'job-exec',
      runId: run.runId
    })
    assert.ok(lease)

    const events: string[] = []
    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {
        events.push('close')
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
      {
        finalizeExecution: async () => {
          events.push('finalize')
          assert.notEqual(await getActiveRun('thread_job', 'job-exec'), null)
          assert.equal(await activeWorkspaceLeaseCount(), 1)
        },
        markExecutionDone: async ({ runId }) => {
          events.push('release-workspace-lease')
          assert.notEqual(await getActiveRun('thread_job', 'job-exec'), null)
          releaseWorkspaceLeaseForOwner('thread_job', 'job-exec', runId)
        }
      }
    )
    assert.deepEqual(events, ['close', 'finalize', 'release-workspace-lease'])
    assert.equal(await activeWorkspaceLeaseCount(), 0)
    assert.equal(await getActiveRun('thread_job', 'job-exec'), null)
  } finally {
    await teardownDb()
  }
})

test('finishExecutionRunLifecycle quarantines and keeps slot and lease when close fails', async () => {
  await setupDb()
  try {
    await seedJob('job-exec-close-fail')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-exec-close-fail',
      kind: 'execution'
    })
    assert.ok(run)
    assert.ok(
      acquireWorkspaceLease({
        workspacePath: '/tmp/ws',
        ownerKind: 'thread_job',
        ownerId: 'job-exec-close-fail',
        runId: run.runId
      })
    )

    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {
        throw new Error('close failed')
      }
    })

    let finalized = false
    let markedDone = false
    await assert.rejects(
      () =>
        finishExecutionRunLifecycle(
          run.runId,
          {
            username: 'user',
            jobId: 'job-exec-close-fail',
            reason: 'execution_done',
            outcome: 'success'
          },
          {
            finalizeExecution: async () => {
              finalized = true
            },
            markExecutionDone: async () => {
              markedDone = true
            }
          }
        ),
      /close failed/
    )

    const active = await getActiveRun('thread_job', 'job-exec-close-fail')
    assert.ok(active)
    assert.equal(active.status, 'stopping')
    assert.equal(finalized, false)
    assert.equal(markedDone, false)
    assert.equal(await activeWorkspaceLeaseCount(), 1)
    assert.equal(hasRunRuntime(run.runId), true)
  } finally {
    await teardownDb()
  }
})

test('finishPlanningRunLifecycle quarantines and keeps slot when close fails', async () => {
  await setupDb()
  try {
    await seedJob('job-plan-close-fail')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-plan-close-fail',
      kind: 'planning'
    })
    assert.ok(run)

    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {
        throw new Error('planning close failed')
      }
    })

    await assert.rejects(
      () => finishPlanningRunLifecycle(run.runId, 'planning_done', 'success'),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.message.includes('Failed to close and release planning run') &&
        error.errors.some(
          (inner) => inner instanceof Error && /planning close failed/.test(inner.message)
        )
    )

    const active = await getActiveRun('thread_job', 'job-plan-close-fail')
    assert.ok(active)
    assert.equal(active.status, 'stopping')
    assert.equal(hasRunRuntime(run.runId), true)
  } finally {
    await teardownDb()
  }
})

test('finishPlanningRunLifecycle escalates a transient close failure and releases the slot', async () => {
  await setupDb()
  try {
    await seedJob('job-plan-close-retry')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-plan-close-retry',
      kind: 'planning'
    })
    assert.ok(run)

    const events: string[] = []
    let closeCalls = 0
    registerRunRuntime(run.runId, {
      kind: 'sandbox-worker',
      cancel: async () => {
        events.push('cancel')
      },
      close: async () => {
        closeCalls += 1
        events.push(`close-${closeCalls}`)
        if (closeCalls === 1) throw new Error('transient planning close failure')
      },
      kill: async () => {
        events.push('kill')
      },
      waitClosed: async () => {
        events.push('waitClosed')
      }
    })

    await finishPlanningRunLifecycle(run.runId, 'planning_done', 'success')

    assert.deepEqual(events, ['close-1', 'cancel', 'close-2', 'kill', 'waitClosed', 'close-3'])
    assert.equal(await getActiveRun('thread_job', 'job-plan-close-retry'), null)
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

    assert.deepEqual(events, ['cancelRun', 'stopRun', 'hardKill', 'waitClosedHook', 'close'])
    assert.equal(await getActiveRun('thread_job', 'job-exec-fail'), null)
  } finally {
    await teardownDb()
  }
})

test('finishExecutionRunLifecycle deletes deferred runtime after slot release', async () => {
  await setupDb()
  try {
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs')
    const { jobRuntimeDir } = await import('../../src/server/runtime/cleanup')
    const { getAppContext } = await import('../../src/server/bootstrap')

    await seedJob('job-exec-cleanup')
    await getDb()
      .update(threadJobs)
      .set({ status: 'failed' })
      .where(eq(threadJobs.id, 'job-exec-cleanup'))

    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-exec-cleanup',
      kind: 'execution'
    })
    assert.ok(run)

    const runtimeDir = jobRuntimeDir(dataDir, 'thread-job-exec-cleanup', 'job-exec-cleanup')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'leftover.txt'), 'pending cleanup')

    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {}
    })

    await finishExecutionRunLifecycle(
      run.runId,
      {
        username: 'user',
        jobId: 'job-exec-cleanup',
        reason: 'execution_failed',
        outcome: 'failure'
      },
      {
        sleep: async () => {},
        finalizeExecution: async () => {
          // Mimic production finalize: drop loop, try cleanup while slot still held.
          getAppContext().executionRuntime.dropRuntime('job-exec-cleanup')
          const { cleanupJobRuntimeTree } = await import('../../src/server/runtime/cleanup')
          const result = await cleanupJobRuntimeTree(
            dataDir,
            'thread-job-exec-cleanup',
            'job-exec-cleanup'
          )
          assert.equal(result, 'deferred_slot')
          assert.ok(existsSync(runtimeDir))
        }
      }
    )

    assert.equal(await getActiveRun('thread_job', 'job-exec-cleanup'), null)
    assert.equal(existsSync(runtimeDir), false, 'runtime should be deleted after slot release')
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

test('finishPlanningRunLifecycle releases slot after normal close', async () => {
  await setupDb()
  try {
    await seedJob('job-plan-close-ok')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-plan-close-ok',
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
    assert.equal(await getActiveRun('thread_job', 'job-plan-close-ok'), null)
    assert.equal(hasRunRuntime(run.runId), false)
  } finally {
    await teardownDb()
  }
})

test('finishPlanningRunLifecycle escalates when first close fails then stop path succeeds', async () => {
  await setupDb()
  try {
    await seedJob('job-plan-escalate')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-plan-escalate',
      kind: 'planning'
    })
    assert.ok(run)

    let closeAttempts = 0
    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {
        closeAttempts += 1
        if (closeAttempts === 1) throw new Error('first close failed')
      },
      cancel: async () => {},
      kill: async () => {},
      waitClosed: async () => {}
    })

    await finishPlanningRunLifecycle(run.runId, 'planning_done', 'success')
    assert.ok(closeAttempts >= 1)
    assert.equal(await getActiveRun('thread_job', 'job-plan-escalate'), null)
  } finally {
    await teardownDb()
  }
})

test('finishPlanningRunLifecycle quarantines when cancel/kill/waitClosed all fail', async () => {
  await setupDb()
  try {
    await seedJob('job-plan-quarantine')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-plan-quarantine',
      kind: 'planning'
    })
    assert.ok(run)

    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {
        throw new Error('close failed')
      }
    })

    await assert.rejects(
      () => finishPlanningRunLifecycle(run.runId, 'planning_done', 'success'),
      (error: unknown) => error instanceof AggregateError
    )

    const active = await getActiveRun('thread_job', 'job-plan-quarantine')
    assert.ok(active, 'durable slot must remain when close is unconfirmed')
    assert.equal(active.status, 'stopping')
  } finally {
    await teardownDb()
  }
})

test('planner admission memory clears even when finishPlanningRunLifecycle quarantines', async () => {
  await setupDb()
  try {
    const { getAppContext } = await import('../../src/server/bootstrap')
    await seedJob('job-plan-mem-clear')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-plan-mem-clear',
      kind: 'planning'
    })
    assert.ok(run)
    assert.equal(
      getAppContext().runtimeRegistry.tryStartJobPlanning('job-plan-mem-clear', 'user'),
      true
    )

    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {
        throw new Error('close failed')
      }
    })

    await assert.rejects(() => finishPlanningRunLifecycle(run.runId, 'planning_done', 'success'))

    // Mirrors runDesignPlanner finally: memory admission must not survive lifecycle failure.
    getAppContext().runtimeRegistry.endJobPlanning('job-plan-mem-clear')
    assert.equal(getAppContext().runtimeRegistry.isJobPlanning('job-plan-mem-clear'), false)
    assert.notEqual(await getActiveRun('thread_job', 'job-plan-mem-clear'), null)
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

    const [runRow] = await getDb().select().from(workloadRuns).where(eq(workloadRuns.id, run.runId))
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
