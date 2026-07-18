import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { and, eq } from 'drizzle-orm'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import {
  resetJobReconcileForTests,
  stopWorkloadReconcilerForTests
} from '../../src/server/legacy-control-plane/reconcile'
import { ensureStartupWorkloadReady } from '../../src/server/legacy-control-plane/workload-slot'
import {
  claimExecutionSlotForJobTx,
  releaseWorkloadSlot,
  resetWorkloadRunControllersForTests
} from '../../src/server/legacy-control-plane/workload-slot-store'
import { findNextPendingJobId } from '../../src/server/legacy-control-plane/repository'
import { listPendingJobIds } from '../../src/server/legacy-control-plane/execution-queue-meta'
import {
  projects,
  threadJobs,
  threadMessages,
  threads,
  workloadRuns,
  workloadSlots
} from '../../src/server/db/schema'

let dataDir: string

async function setupDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-exec-claim-'))
  await resetAppContextForTests()
  resetJobReconcileForTests()
  bootstrapRuntime({ dataDir })
  await ensureStartupWorkloadReady()
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

interface SeedOptions {
  status?: string
  planConfirmedAt?: number | null
  createdAt?: number
  username?: string
}

async function seedJob(jobId: string, options: SeedOptions = {}): Promise<void> {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const username = options.username ?? 'user'
  const projectId = `proj-${jobId}`
  const threadId = `thread-${jobId}`
  const draftId = `draft-${jobId}`

  await db.insert(projects).values({
    id: projectId,
    username,
    title: 'P',
    workspaceRoot: `/tmp/ws-${jobId}`,
    createdAt: now,
    updatedAt: now
  })
  await db.insert(threads).values({
    id: threadId,
    username,
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
    username,
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
    username,
    draftMessageId: draftId,
    title: 'Test',
    summary: '',
    status: options.status ?? 'pending',
    workspacePath: '/tmp/ws',
    planConfirmedAt: options.planConfirmedAt === undefined ? now : options.planConfirmedAt,
    createdAt: options.createdAt ?? now,
    updatedAt: now
  })
}

async function countActiveExecutionSlots(): Promise<number> {
  const rows = await getDb()
    .select({ runId: workloadSlots.runId })
    .from(workloadSlots)
    .where(and(eq(workloadSlots.pool, 'execution'), eq(workloadSlots.status, 'active')))
  return rows.length
}

async function jobStatus(jobId: string): Promise<string | undefined> {
  const rows = await getDb()
    .select({ status: threadJobs.status, activeRunId: threadJobs.activeRunId })
    .from(threadJobs)
    .where(eq(threadJobs.id, jobId))
    .limit(1)
  return rows[0]?.status
}

test('pending job without planConfirmedAt cannot be claimed', async () => {
  await setupDb()
  try {
    await seedJob('job-unconfirmed', { planConfirmedAt: null })

    const slot = await claimExecutionSlotForJobTx('user', 'job-unconfirmed')
    assert.equal(slot, null)
    assert.equal(await jobStatus('job-unconfirmed'), 'pending')
    assert.equal(await countActiveExecutionSlots(), 0)
  } finally {
    await teardownDb()
  }
})

test('empty pool: atomic claim promotes A to running with run+slot+activeRunId', async () => {
  await setupDb()
  try {
    await seedJob('job-a')

    const slot = await claimExecutionSlotForJobTx('user', 'job-a')
    assert.ok(slot)

    const row = (
      await getDb().select().from(threadJobs).where(eq(threadJobs.id, 'job-a')).limit(1)
    )[0]
    assert.equal(row?.status, 'running')
    assert.equal(row?.activeRunId, slot.runId)
    assert.ok(row?.executionLeaseOwner)
    assert.ok(row?.executionLeaseExpiresAt)

    const runs = await getDb()
      .select()
      .from(workloadRuns)
      .where(eq(workloadRuns.ownerId, 'job-a'))
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.pool, 'execution')
    assert.equal(runs[0]?.status, 'active')
    assert.equal(await countActiveExecutionSlots(), 1)
  } finally {
    await teardownDb()
  }
})

test('A running: confirm B is rejected, at most one active execution slot, no orphan', async () => {
  await setupDb()
  try {
    await seedJob('job-a')
    await seedJob('job-b')

    const a = await claimExecutionSlotForJobTx('user', 'job-a')
    assert.ok(a)

    const b = await claimExecutionSlotForJobTx('user', 'job-b')
    assert.equal(b, null)

    assert.equal(await jobStatus('job-b'), 'pending')
    assert.equal(await countActiveExecutionSlots(), 1)

    const bRuns = await getDb()
      .select()
      .from(workloadRuns)
      .where(eq(workloadRuns.ownerId, 'job-b'))
    assert.equal(bRuns.length, 0)
    const bSlots = await getDb()
      .select()
      .from(workloadSlots)
      .where(eq(workloadSlots.ownerId, 'job-b'))
    assert.equal(bSlots.length, 0)
  } finally {
    await teardownDb()
  }
})

test('concurrent confirm of two plans yields exactly one active execution slot', async () => {
  await setupDb()
  try {
    await seedJob('job-a')
    await seedJob('job-b')

    const [a, b] = await Promise.all([
      claimExecutionSlotForJobTx('user', 'job-a'),
      claimExecutionSlotForJobTx('user', 'job-b')
    ])

    const claimed = [a, b].filter(Boolean)
    assert.equal(claimed.length, 1)
    assert.equal(await countActiveExecutionSlots(), 1)
  } finally {
    await teardownDb()
  }
})

test('claim mid-failure (non-pending job) rolls back: no orphan run/slot, job retryable', async () => {
  await setupDb()
  try {
    // Job already running (e.g. a stale/duplicate advance): CAS must fail.
    await seedJob('job-a', { status: 'running' })

    const rejected = await claimExecutionSlotForJobTx('user', 'job-a')
    assert.equal(rejected, null)
    assert.equal(await countActiveExecutionSlots(), 0)

    const runs = await getDb()
      .select()
      .from(workloadRuns)
      .where(eq(workloadRuns.ownerId, 'job-a'))
    assert.equal(runs.length, 0)

    // Retryable: once genuinely pending again, the claim succeeds.
    await getDb().update(threadJobs).set({ status: 'pending' }).where(eq(threadJobs.id, 'job-a')).run()
    const retried = await claimExecutionSlotForJobTx('user', 'job-a')
    assert.ok(retried)
    assert.equal(await countActiveExecutionSlots(), 1)
  } finally {
    await teardownDb()
  }
})

test('re-confirm same job does not create a second run/slot', async () => {
  await setupDb()
  try {
    await seedJob('job-a')

    const first = await claimExecutionSlotForJobTx('user', 'job-a')
    assert.ok(first)

    // Re-confirming the same (already running) job must be a no-op at the claim.
    const second = await claimExecutionSlotForJobTx('user', 'job-a')
    assert.equal(second, null)

    const runs = await getDb()
      .select()
      .from(workloadRuns)
      .where(eq(workloadRuns.ownerId, 'job-a'))
    assert.equal(runs.length, 1)
    assert.equal(await countActiveExecutionSlots(), 1)
  } finally {
    await teardownDb()
  }
})

test('A completes → only B starts; B completes → only C (FIFO + single slot)', async () => {
  await setupDb()
  try {
    const base = Math.floor(Date.now() / 1000)
    await seedJob('job-a', { planConfirmedAt: base + 1 })
    await seedJob('job-b', { planConfirmedAt: base + 2 })
    await seedJob('job-c', { planConfirmedAt: base + 3 })

    // Pool empty → next is A.
    assert.equal(await findNextPendingJobId('user'), 'job-a')
    const a = await claimExecutionSlotForJobTx('user', 'job-a')
    assert.ok(a)

    // A running → next pending is B, but capacity is full so B cannot claim.
    assert.equal(await findNextPendingJobId('user'), 'job-b')
    assert.equal(await claimExecutionSlotForJobTx('user', 'job-b'), null)

    // A completes.
    await releaseWorkloadSlot(a.runId, { reason: 'execution_done', skipQueueAdvance: true })
    await getDb().update(threadJobs).set({ status: 'completed' }).where(eq(threadJobs.id, 'job-a')).run()

    // Only B is next; C stays pending.
    assert.equal(await findNextPendingJobId('user'), 'job-b')
    const b = await claimExecutionSlotForJobTx('user', 'job-b')
    assert.ok(b)
    assert.equal(await claimExecutionSlotForJobTx('user', 'job-c'), null)

    // B completes → only C.
    await releaseWorkloadSlot(b.runId, { reason: 'execution_done', skipQueueAdvance: true })
    await getDb().update(threadJobs).set({ status: 'completed' }).where(eq(threadJobs.id, 'job-b')).run()
    assert.equal(await findNextPendingJobId('user'), 'job-c')
    const c = await claimExecutionSlotForJobTx('user', 'job-c')
    assert.ok(c)
    assert.equal(await countActiveExecutionSlots(), 1)
  } finally {
    await teardownDb()
  }
})

test('FIFO order is planConfirmedAt ASC, then createdAt ASC, then id ASC', async () => {
  await setupDb()
  try {
    const base = Math.floor(Date.now() / 1000)
    // Deliberately insert out of order; same planConfirmedAt for the last two.
    await seedJob('job-3', { planConfirmedAt: base + 30, createdAt: base + 1 })
    await seedJob('job-1', { planConfirmedAt: base + 10, createdAt: base + 5 })
    await seedJob('job-2b', { planConfirmedAt: base + 20, createdAt: base + 9 })
    await seedJob('job-2a', { planConfirmedAt: base + 20, createdAt: base + 9 })

    const order = await listPendingJobIds('user')
    assert.deepEqual(order, ['job-1', 'job-2a', 'job-2b', 'job-3'])
    assert.equal(await findNextPendingJobId('user'), 'job-1')
  } finally {
    await teardownDb()
  }
})

test('global FIFO picks earliest pending across users', async () => {
  await setupDb()
  try {
    const base = Math.floor(Date.now() / 1000)
    await seedJob('job-b', { username: 'bob', planConfirmedAt: base + 20 })
    await seedJob('job-a', { username: 'alice', planConfirmedAt: base + 10 })

    assert.equal(await findNextPendingJobId(), 'job-a')
    const a = await claimExecutionSlotForJobTx('alice', 'job-a')
    assert.ok(a)
    assert.equal(await findNextPendingJobId(), 'job-b')
    assert.equal(await claimExecutionSlotForJobTx('bob', 'job-b'), null)
    assert.equal(await countActiveExecutionSlots(), 1)
  } finally {
    await teardownDb()
  }
})
