import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, closeDatabaseForTests, getDb } from '../../src/server/db'
import { threadJobs, threadMessages, threads, projects } from '../../src/server/db/schema'
import { eq } from 'drizzle-orm'
import type { createIsolatedTestDatabase } from '../../src/server/db'
import {
  claimWorkloadSlotTx,
  releaseWorkloadSlot,
  getActiveRun,
  assertRunActive,
  assertRunWritable,
  markRunCancelling,
  workloadPoolCapacity,
  resetWorkloadRunControllersForTests
} from '../../src/server/jobs/workload-slot-store'
import { updateJobRowFenced } from '../../src/server/jobs/repository'
import {
  registerPlannerMcpSession,
  unregisterPlannerMcpSession,
  type PlannerMcpSession
} from '../../src/server/planner/mcp/session'
import { handlePlannerMcpJsonRpc } from '../../src/server/planner/mcp/handler'

let dataDir: string

function setupDb(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-workload-slot-'))
  createDatabase(dataDir)
}

function teardownDb(): void {
  try {
    closeDatabaseForTests()
  } catch {
    // ignore
  }
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
  resetWorkloadRunControllersForTests()
}

async function seedJob(
  db: ReturnType<typeof createIsolatedTestDatabase>,
  jobId: string,
  status: string
): Promise<void> {
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

test('claim capacity=1 rejects second run', async () => {
  setupDb()
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
    teardownDb()
  }
})

test('capacity=N allows N runs', async () => {
  setupDb()
  const previousCapacity = process.env.CODETASK_WORKLOAD_POOL_CAPACITY
  process.env.CODETASK_WORKLOAD_POOL_CAPACITY = '2'
  try {
    const db = getDb()
    await seedJob(db, 'job-1', 'planning')
    await seedJob(db, 'job-2', 'planning')
    await seedJob(db, 'job-3', 'planning')

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
    const third = await claimWorkloadSlotTx({
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-3',
      kind: 'planning'
    })

    assert.ok(first)
    assert.ok(second)
    assert.equal(third, null)
    assert.equal(workloadPoolCapacity('default'), 2)
  } finally {
    process.env.CODETASK_WORKLOAD_POOL_CAPACITY = previousCapacity
    teardownDb()
  }
})

test('release is idempotent', async () => {
  setupDb()
  const previousCapacity = process.env.CODETASK_WORKLOAD_POOL_CAPACITY
  process.env.CODETASK_WORKLOAD_POOL_CAPACITY = '1'
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
    process.env.CODETASK_WORKLOAD_POOL_CAPACITY = previousCapacity
    teardownDb()
  }
})

test('stale release does not clear newer active_run_id', async () => {
  setupDb()
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
    teardownDb()
  }
})

test('fenced update rejects stale run', async () => {
  setupDb()
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

    const patched = await updateJobRowFenced('job-1', oldRun.runId, { status: 'failed' })
    assert.equal(patched, null)

    const row = await db.select().from(threadJobs).where(eq(threadJobs.id, 'job-1')).limit(1)
    assert.notEqual(row[0]?.status, 'failed')
  } finally {
    teardownDb()
  }
})

test('assertRunActive is false after release', async () => {
  setupDb()
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
    teardownDb()
  }
})

test('assertRunWritable is false while run is cancelling', async () => {
  setupDb()
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
    teardownDb()
  }
})

test('MCP handler rejects stale run', async () => {
  setupDb()
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
      registeredPlan: null
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
      assert.equal((result.body as { error?: { message?: string } }).error?.message, 'Plan session closed or stale run')
    } finally {
      unregisterPlannerMcpSession('plan-mcp-test')
    }
  } finally {
    teardownDb()
  }
})
