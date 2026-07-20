import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  bootstrapRuntime,
  getAppContext,
  resetAppContextForTests
} from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import {
  reconcileOrphanWorkloadSlotsOnStartup,
  resetJobReconcileForTests,
  stopWorkloadReconcilerForTests
} from '../../src/server/legacy-control-plane/reconcile'
import { ensureStartupWorkloadReady } from '../../src/server/legacy-control-plane/workload-slot'
import {
  jobArtifacts,
  jobTasks,
  threadJobs,
  threadMessages,
  threads,
  projects,
  workloadRuns,
  workloadSlots
} from '../../src/server/db/schema'
import { eq } from 'drizzle-orm'
import type { getDb as GetDb } from '../../src/server/db'
import {
  claimWorkloadSlotTx,
  releaseWorkloadSlot,
  getActiveRun,
  assertRunActive,
  assertRunWritable,
  markRunCancelling,
  refreshWorkloadLease,
  workloadPoolCapacity,
  resetWorkloadRunControllersForTests
} from '../../src/server/legacy-control-plane/workload-slot-store'
import { updateJobRowFenced } from '../../src/server/legacy-control-plane/repository'
import { hydrateTaskEvidenceSync } from '../../src/server/legacy-control-plane/evidence/store'
import type { TaskProgressDto } from '../../src/server/legacy-control-plane/types'
import {
  registerPlannerMcpSession,
  unregisterPlannerMcpSession,
  type PlannerMcpSession
} from '../../src/server/planner/mcp/session'
import { handlePlannerMcpJsonRpc } from '../../src/server/planner/mcp/handler'

let dataDir: string

async function setupDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-workload-slot-'))
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
  // Unit tests claim planning slots; stop startup reconciler so it does not
  // mark seeded planning rows as failed mid-test.
  stopWorkloadReconcilerForTests()
}

async function teardownDb(): Promise<void> {
  resetWorkloadRunControllersForTests()
  await resetAppContextForTests()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

async function seedJob(db: ReturnType<typeof GetDb>, jobId: string, status: string): Promise<void> {
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
    status,
    workspacePath: '/tmp/ws',
    createdAt: now,
    updatedAt: now
  })
}

function progressWithEvidence(summary: string): TaskProgressDto {
  // Full evidence artifacts are only persisted for failed/blocked evidence.
  return {
    phase: 'running',
    status: 'running',
    currentIndex: 0,
    total: 1,
    currentTaskId: 'task-1',
    message: summary,
    tasks: [
      {
        id: 'task-1',
        title: 'Task 1',
        status: 'failed',
        executionStatus: 'failed',
        evidenceStatus: 'ready',
        evidence: {
          status: 'failed',
          summary,
          changedFiles: ['src/a.ts'],
          evidence: ['line'],
          validation: { ran: true, outcome: 'failed' }
        }
      }
    ]
  }
}

test('claim capacity=1 rejects second run', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-1', 'planning')
    await seedJob(db, 'job-2', 'planning')

    const first = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(first)

    const second = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-2',
      kind: 'planning'
    })
    assert.equal(second, null)
  } finally {
    await teardownDb()
  }
})

test('workload capacity remains fixed at 1 in TS config', () => {
  assert.equal(workloadPoolCapacity('execution'), 1)
  assert.equal(workloadPoolCapacity('default'), 1)
})

test('capacity 1 semantics: only one active run per pool', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-1', 'planning')
    await seedJob(db, 'job-2', 'planning')

    const first = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    const second = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-2',
      kind: 'planning'
    })

    assert.ok(first)
    assert.equal(second, null)
    assert.equal(workloadPoolCapacity('default'), 1)
    assert.equal(workloadPoolCapacity('execution'), 1)
  } finally {
    await teardownDb()
  }
})

test('release is idempotent', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-1', 'planning')

    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(run)

    const first = await releaseWorkloadSlot(run.runId, { reason: 'test' })
    const second = await releaseWorkloadSlot(run.runId, { reason: 'test' })

    assert.equal(first.released, true)
    assert.equal(second.released, false)
  } finally {
    await teardownDb()
  }
})

test('periodic reconcile releases a finished planning owner before lease expiry', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-finished-plan', 'planning')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-finished-plan',
      kind: 'planning',
      pool: 'planning'
    })
    assert.ok(run)
    assert.equal(
      getAppContext().runtimeRegistry.tryStartJobPlanning('job-finished-plan', 'user'),
      true
    )

    db.update(threadJobs)
      .set({
        status: 'published',
        planStatus: 'completed',
        updatedAt: Math.floor(Date.now() / 1000) - 61
      })
      .where(eq(threadJobs.id, 'job-finished-plan'))
      .run()

    await reconcileOrphanWorkloadSlotsOnStartup('periodic_reconcile_stale')

    const reconciled = db.select().from(workloadRuns).where(eq(workloadRuns.id, run.runId)).get()
    assert.equal(reconciled?.status, 'released')
    assert.equal(reconciled?.cancelReason, 'periodic_reconcile_stale')
    assert.equal(await getActiveRun('thread_job', 'job-finished-plan'), null)
    assert.equal(getAppContext().runtimeRegistry.isJobPlanning('job-finished-plan'), false)
  } finally {
    await teardownDb()
  }
})

test('stale release does not clear newer active_run_id', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-1', 'planning')

    const oldRun = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(oldRun)
    await releaseWorkloadSlot(oldRun.runId, { reason: 'test' })

    const newRun = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(newRun)

    const stale = await releaseWorkloadSlot(oldRun.runId, { reason: 'test' })
    assert.equal(stale.released, false)

    const active = await getActiveRun('thread_job', 'job-1')
    assert.equal(active?.runId, newRun.runId)
  } finally {
    await teardownDb()
  }
})

test('fenced update rejects stale run', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-1', 'planning')

    const oldRun = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(oldRun)
    await releaseWorkloadSlot(oldRun.runId, { reason: 'test', skipQueueAdvance: true })

    const patched = await updateJobRowFenced('job-1', oldRun.runId, { status: 'failed' })
    assert.equal(patched, null)

    const row = await db.select().from(threadJobs).where(eq(threadJobs.id, 'job-1')).limit(1)
    assert.notEqual(row[0]?.status, 'failed')
  } finally {
    await teardownDb()
  }
})

test('stale fenced update does not replace committed evidence artifacts', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-1', 'planning')

    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(run)

    const saved = await updateJobRowFenced('job-1', run.runId, {
      taskProgress: progressWithEvidence('committed evidence')
    })
    assert.ok(saved)

    const taskRows = await db.select().from(jobTasks).where(eq(jobTasks.jobId, 'job-1')).limit(1)
    const originalArtifactId = taskRows[0]?.evidenceArtifactId
    assert.ok(originalArtifactId)

    await releaseWorkloadSlot(run.runId, { reason: 'test', skipQueueAdvance: true })

    const rejected = await updateJobRowFenced('job-1', run.runId, {
      taskProgress: progressWithEvidence('stale evidence')
    })
    assert.equal(rejected, null)

    const afterTaskRows = await db
      .select()
      .from(jobTasks)
      .where(eq(jobTasks.jobId, 'job-1'))
      .limit(1)
    assert.equal(afterTaskRows[0]?.evidenceArtifactId, originalArtifactId)

    const artifacts = await db.select().from(jobArtifacts).where(eq(jobArtifacts.jobId, 'job-1'))
    assert.equal(artifacts.length, 1)

    const hydrated = hydrateTaskEvidenceSync(
      dataDir,
      afterTaskRows[0]?.evidenceJson ? JSON.parse(afterTaskRows[0].evidenceJson) : null,
      originalArtifactId,
      db
    )
    assert.equal(hydrated?.summary, 'committed evidence')
    assert.equal(hydrated?.status, 'failed')
  } finally {
    await teardownDb()
  }
})

test('assertRunActive is false after release', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-1', 'planning')

    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(run)
    assert.equal(await assertRunActive('thread_job', 'job-1', run.runId), true)

    await releaseWorkloadSlot(run.runId, { reason: 'test' })
    assert.equal(await assertRunActive('thread_job', 'job-1', run.runId), false)
  } finally {
    await teardownDb()
  }
})

test('refreshWorkloadLease fails closed and rolls back a partial refresh', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-refresh', 'planning')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-refresh',
      kind: 'planning'
    })
    assert.ok(run)

    const claimed = db
      .select({ leaseExpiresAt: workloadRuns.leaseExpiresAt })
      .from(workloadRuns)
      .where(eq(workloadRuns.id, run.runId))
      .get()
    assert.ok(claimed)
    const shortenedExpiry = claimed.leaseExpiresAt - 60
    db.update(workloadRuns)
      .set({ leaseExpiresAt: shortenedExpiry })
      .where(eq(workloadRuns.id, run.runId))
      .run()
    db.delete(workloadSlots).where(eq(workloadSlots.runId, run.runId)).run()

    await assert.rejects(
      () => refreshWorkloadLease(run.runId),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'workspace.lease_lost'
    )
    const after = db
      .select({ leaseExpiresAt: workloadRuns.leaseExpiresAt })
      .from(workloadRuns)
      .where(eq(workloadRuns.id, run.runId))
      .get()
    assert.equal(after?.leaseExpiresAt, shortenedExpiry)
  } finally {
    await teardownDb()
  }
})

test('assertRunWritable is false while run is cancelling', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-1', 'planning')

    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(run)
    assert.equal(await assertRunActive('thread_job', 'job-1', run.runId), true)
    assert.equal(await assertRunWritable('thread_job', 'job-1', run.runId), true)

    await markRunCancelling(run.runId, 'user_stop')
    assert.equal(await assertRunActive('thread_job', 'job-1', run.runId), true)
    assert.equal(await assertRunWritable('thread_job', 'job-1', run.runId), false)
  } finally {
    await teardownDb()
  }
})

test('MCP handler rejects stale run', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-1', 'planning')

    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      kind: 'planning'
    })
    assert.ok(run)

    const session: PlannerMcpSession = {
      sessionId: 'plan-mcp-test',
      jobId: 'job-1',
      threadId: 'thread-job-1',
      runId: run.runId,
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      allowedAbilityCodes: ['code'],
      validReferenceIds: [],
      taskContexts: new Map(),
      planOutline: null
    }
    registerPlannerMcpSession(session)
    try {
      await releaseWorkloadSlot(run.runId, { reason: 'test' })

      const result = await handlePlannerMcpJsonRpc('plan-mcp-test', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'register_task_context',
          arguments: {
            milestone: 1,
            slice: 1,
            task: 1,
            taskTitle: 't',
            content: 'c'
          }
        }
      })

      assert.equal(result.kind, 'json')
      assert.equal(
        (result.body as { error?: { message?: string } }).error?.message,
        'Plan session closed or stale run'
      )
    } finally {
      unregisterPlannerMcpSession('plan-mcp-test')
    }
  } finally {
    await teardownDb()
  }
})

test('cross-user planning claim is blocked while another user holds the global slot', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-alice', 'planning')
    await seedJob(db, 'job-bob', 'planning')
    db.update(threadJobs).set({ username: 'alice' }).where(eq(threadJobs.id, 'job-alice')).run()
    db.update(threadJobs).set({ username: 'bob' }).where(eq(threadJobs.id, 'job-bob')).run()
    db.update(threads).set({ username: 'alice' }).where(eq(threads.id, 'thread-job-alice')).run()
    db.update(threads).set({ username: 'bob' }).where(eq(threads.id, 'thread-job-bob')).run()

    const alice = await claimWorkloadSlotTx({
      username: 'alice',
      ownerKind: 'thread_job',
      ownerId: 'job-alice',
      kind: 'planning',
      pool: 'planning'
    })
    assert.ok(alice)

    const bob = await claimWorkloadSlotTx({
      username: 'bob',
      ownerKind: 'thread_job',
      ownerId: 'job-bob',
      kind: 'planning',
      pool: 'planning'
    })
    assert.equal(bob, null)

    await releaseWorkloadSlot(alice.runId, { reason: 'test' })
    const bobAfter = await claimWorkloadSlotTx({
      username: 'bob',
      ownerKind: 'thread_job',
      ownerId: 'job-bob',
      kind: 'planning',
      pool: 'planning'
    })
    assert.ok(bobAfter)
  } finally {
    await teardownDb()
  }
})

test('concurrent planning claims admit at most one active slot', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-c1', 'planning')
    await seedJob(db, 'job-c2', 'planning')
    await seedJob(db, 'job-c3', 'planning')

    const results = await Promise.all([
      claimWorkloadSlotTx({
        username: 'user',
        ownerKind: 'thread_job',
        ownerId: 'job-c1',
        kind: 'planning',
        pool: 'planning'
      }),
      claimWorkloadSlotTx({
        username: 'user',
        ownerKind: 'thread_job',
        ownerId: 'job-c2',
        kind: 'planning',
        pool: 'planning'
      }),
      claimWorkloadSlotTx({
        username: 'user',
        ownerKind: 'thread_job',
        ownerId: 'job-c3',
        kind: 'planning',
        pool: 'planning'
      })
    ])
    assert.equal(results.filter(Boolean).length, 1)
  } finally {
    await teardownDb()
  }
})

test('terminal planning owner under 60s grace is not reclaimed', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-grace', 'planning')
    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-grace',
      kind: 'planning',
      pool: 'planning'
    })
    assert.ok(run)

    db.update(threadJobs)
      .set({
        status: 'published',
        planStatus: 'completed',
        updatedAt: Math.floor(Date.now() / 1000) - 30
      })
      .where(eq(threadJobs.id, 'job-grace'))
      .run()

    await reconcileOrphanWorkloadSlotsOnStartup('periodic_reconcile_stale')
    assert.notEqual(await getActiveRun('thread_job', 'job-grace'), null)
  } finally {
    await teardownDb()
  }
})

test('quarantined planning slot continues to block global admission', async () => {
  await setupDb()
  try {
    const db = getDb()
    await seedJob(db, 'job-quarantine-fence', 'planning')
    await seedJob(db, 'job-waiting', 'planning')

    const run = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-quarantine-fence',
      kind: 'planning',
      pool: 'planning'
    })
    assert.ok(run)

    const { stopRunLifecycle } = await import('../../src/server/legacy-control-plane/run-lifecycle')
    const { registerRunRuntime, resetRuntimeSupervisorForTests } =
      await import('../../src/server/legacy-control-plane/runtime-supervisor')
    resetRuntimeSupervisorForTests()
    registerRunRuntime(run.runId, {
      kind: 'cursor-acp',
      close: async () => {}
    })

    await assert.rejects(
      () =>
        stopRunLifecycle(run.runId, 'child_close_unconfirmed', {
          sleep: async () => {},
          waitClosed: async () => {
            throw new Error('provider close unconfirmed')
          }
        }),
      /provider close unconfirmed/
    )

    assert.notEqual(await getActiveRun('thread_job', 'job-quarantine-fence'), null)
    const blocked = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-waiting',
      kind: 'planning',
      pool: 'planning'
    })
    assert.equal(
      blocked,
      null,
      'unconfirmed provider close must keep the durable slot and block admission'
    )
  } finally {
    await teardownDb()
  }
})

test('advancePlanningQueue is a no-op while draining', async () => {
  await setupDb()
  try {
    const { beginDraining, endDraining } =
      await import('../../src/server/legacy-control-plane/shutdown-state')
    const { advancePlanningQueue } =
      await import('../../src/server/legacy-control-plane/queue-coordinator')
    const db = getDb()
    await seedJob(db, 'job-drain', 'planning')
    db.update(threadJobs)
      .set({ planStatus: 'pending', status: 'planning' })
      .where(eq(threadJobs.id, 'job-drain'))
      .run()

    beginDraining()
    try {
      await advancePlanningQueue()
      assert.equal(await getActiveRun('thread_job', 'job-drain'), null)
    } finally {
      endDraining()
    }
  } finally {
    await teardownDb()
  }
})

test('periodic reconcile advances queues even when no stale slots exist', async () => {
  await setupDb()
  try {
    const { runPeriodicWorkloadReconcile } =
      await import('../../src/server/legacy-control-plane/reconcile')
    await runPeriodicWorkloadReconcile()
    await runPeriodicWorkloadReconcile()
  } finally {
    await teardownDb()
  }
})
