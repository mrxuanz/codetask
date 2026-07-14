import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { and, eq } from 'drizzle-orm'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import {
  reconcileOrphanRunningJobsForUser,
  resetJobReconcileForTests,
  stopWorkloadReconcilerForTests
} from '../../src/server/legacy-control-plane/reconcile'
import { ensureStartupWorkloadReady } from '../../src/server/legacy-control-plane/workload-slot'
import { resetWorkloadRunControllersForTests } from '../../src/server/legacy-control-plane/workload-slot-store'
import { findNextPendingJobId } from '../../src/server/legacy-control-plane/repository'
import { beginDraining, endDraining } from '../../src/server/legacy-control-plane/shutdown-state'
import {
  beginTaskAttempt,
  commitCompletedTaskAttempt,
  deriveIdempotencyKey,
  deriveTaskIdempotencyKey,
  hasCompletedAttempt,
  markAllRunningAttemptsInterrupted,
  markRunningAttemptsInterruptedForJob
} from '../../src/server/legacy-control-plane/task-attempts'
import {
  jobTaskAttempts,
  jobTasks,
  projects,
  threadJobs,
  threadMessages,
  threads
} from '../../src/server/db/schema'

let dataDir: string

async function setupDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-f3-recovery-'))
  await resetAppContextForTests()
  resetJobReconcileForTests()
  bootstrapRuntime({ dataDir })
  await ensureStartupWorkloadReady()
  stopWorkloadReconcilerForTests()
  endDraining()
}

async function teardownDb(): Promise<void> {
  // reconcile's auto-resume fires a fire-and-forget `advanceExecutionQueue`. Keep draining TRUE and
  // flush that background task so it no-ops (returns at the draining gate) BEFORE we reset. Otherwise
  // it races teardown, wins with draining=false, and starts a real execution loop that never exits.
  beginDraining()
  await new Promise((resolve) => setTimeout(resolve, 50))
  resetWorkloadRunControllersForTests()
  await resetAppContextForTests()
  endDraining()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

interface SeedOptions {
  status?: string
  planConfirmedAt?: number
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
    planConfirmedAt: options.planConfirmedAt ?? now,
    createdAt: options.createdAt ?? now,
    updatedAt: now,
    // A stale lease from a previous, now-dead process.
    executionLeaseOwner: 'dead-pid-0000',
    executionLeaseExpiresAt: now + 600
  })
}

async function jobStatus(jobId: string): Promise<string | undefined> {
  const rows = await getDb()
    .select({ status: threadJobs.status })
    .from(threadJobs)
    .where(eq(threadJobs.id, jobId))
    .limit(1)
  return rows[0]?.status
}

test('F3-A: user paused job stays paused across a reconcile pass (no auto-run)', async () => {
  await setupDb()
  try {
    await seedJob('job-paused', { status: 'paused' })

    // The running-job reconciler must not touch paused jobs.
    await reconcileOrphanRunningJobsForUser('user')

    assert.equal(await jobStatus('job-paused'), 'paused')
  } finally {
    await teardownDb()
  }
})

test('F3-A: interrupted running job auto-resumes (stays running, not failed)', async () => {
  await setupDb()
  try {
    await seedJob('job-run', { status: 'running' })
    // A leftover running attempt from the dead process.
    await getDb()
      .insert(jobTaskAttempts)
      .values({
        id: 'jta-old',
        jobId: 'job-run',
        taskId: 'task-1',
        runId: null,
        attemptNo: 1,
        idempotencyKey: deriveIdempotencyKey('job-run', 'task-1', 1),
        status: 'running',
        startedAt: Math.floor(Date.now() / 1000)
      })

    // Suppress the fire-and-forget queue advance so we assert only the reconcile state change.
    beginDraining()
    await reconcileOrphanRunningJobsForUser('user')

    // Process interruption must NOT map to a user failure.
    assert.equal(await jobStatus('job-run'), 'running')

    // The stale attempt is interrupted so a fresh attempt can resume under the same identity.
    const attempt = (
      await getDb()
        .select({ status: jobTaskAttempts.status })
        .from(jobTaskAttempts)
        .where(eq(jobTaskAttempts.id, 'jta-old'))
    )[0]
    assert.equal(attempt?.status, 'interrupted')

    // The dead process's lease is cleared so this boot can re-lease.
    const row = (
      await getDb()
        .select({ owner: threadJobs.executionLeaseOwner })
        .from(threadJobs)
        .where(eq(threadJobs.id, 'job-run'))
    )[0]
    assert.equal(row?.owner ?? null, null)
  } finally {
    await teardownDb()
  }
})

test('F3-A/F2: pending FIFO order is preserved after a running job is resumed', async () => {
  await setupDb()
  try {
    const base = Math.floor(Date.now() / 1000)
    await seedJob('job-run', { status: 'running', planConfirmedAt: base + 1 })
    await seedJob('job-a', { status: 'pending', planConfirmedAt: base + 2 })
    await seedJob('job-b', { status: 'pending', planConfirmedAt: base + 3 })

    beginDraining()
    await reconcileOrphanRunningJobsForUser('user')

    assert.equal(await jobStatus('job-run'), 'running')
    assert.equal(await jobStatus('job-a'), 'pending')
    assert.equal(await jobStatus('job-b'), 'pending')
    // Earliest planConfirmedAt pending job is next in the FIFO queue.
    assert.equal(await findNextPendingJobId('user'), 'job-a')
  } finally {
    await teardownDb()
  }
})

test('F3-B: attempt lifecycle — begin, complete, never re-run, unique idempotency', async () => {
  await setupDb()
  try {
    await seedJob('job-att', { status: 'running' })
    await getDb().insert(jobTasks).values({
      jobId: 'job-att',
      taskId: 'task-1',
      title: 'T1',
      sortOrder: 0,
      status: 'running',
      executionStatus: 'running'
    })

    assert.equal(hasCompletedAttempt('job-att', 'task-1'), false)

    const first = beginTaskAttempt({ jobId: 'job-att', taskId: 'task-1', runId: null })
    assert.equal(first.kind, 'started')
    if (first.kind !== 'started') throw new Error('unreachable')
    assert.equal(first.attemptNo, 1)
    const expectedKey = deriveTaskIdempotencyKey({
      jobId: 'job-att',
      taskId: 'task-1',
      snapshotPlanRevision: 0
    })
    assert.equal(first.idempotencyKey, expectedKey)

    // Complete atomically: attempt completed + job checkpoint stamped in one transaction.
    commitCompletedTaskAttempt({
      jobId: 'job-att',
      taskId: 'task-1',
      attemptNo: first.attemptNo,
      result: { status: 'completed', summary: 'done' }
    })
    assert.equal(hasCompletedAttempt('job-att', 'task-1'), true)

    const taskRow = (
      await getDb()
        .select({ status: jobTasks.status })
        .from(jobTasks)
        .where(eq(jobTasks.taskId, 'task-1'))
    )[0]
    assert.equal(taskRow?.status, 'completed')

    // A completed task is never re-run.
    const second = beginTaskAttempt({ jobId: 'job-att', taskId: 'task-1', runId: null })
    assert.equal(second.kind, 'already-completed')

    // UNIQUE(idempotency_key) is enforced by the DB.
    assert.throws(() => {
      void getDb()
        .insert(jobTaskAttempts)
        .values({
          id: 'jta-dup',
          jobId: 'job-att',
          taskId: 'task-1',
          runId: null,
          attemptNo: 99,
          idempotencyKey: expectedKey,
          status: 'running',
          startedAt: Math.floor(Date.now() / 1000)
        })
        .run()
    })
  } finally {
    await teardownDb()
  }
})

test('R1: stable idempotency key across retries; begin fails closed for foreign task', async () => {
  await setupDb()
  try {
    await seedJob('job-r1', { status: 'running' })
    await getDb().insert(jobTasks).values({
      jobId: 'job-r1',
      taskId: 'task-a',
      title: 'A',
      sortOrder: 0,
      status: 'running',
      executionStatus: 'running'
    })

    const first = beginTaskAttempt({
      jobId: 'job-r1',
      taskId: 'task-a',
      runId: null,
      snapshotPlanRevision: 3
    })
    assert.equal(first.kind, 'started')
    if (first.kind !== 'started') throw new Error('unreachable')
    const key = deriveTaskIdempotencyKey({
      jobId: 'job-r1',
      taskId: 'task-a',
      snapshotPlanRevision: 3
    })
    assert.equal(first.idempotencyKey, key)

    markRunningAttemptsInterruptedForJob('job-r1')
    const retry = beginTaskAttempt({
      jobId: 'job-r1',
      taskId: 'task-a',
      runId: null,
      snapshotPlanRevision: 3
    })
    assert.equal(retry.kind, 'started')
    if (retry.kind !== 'started') throw new Error('unreachable')
    assert.equal(retry.attemptNo, 2)
    assert.equal(retry.idempotencyKey, key)

    assert.throws(() => beginTaskAttempt({ jobId: 'job-r1', taskId: 'missing-task', runId: null }))
  } finally {
    await teardownDb()
  }
})

test('R1: commit conflict does not stamp task completed', async () => {
  await setupDb()
  try {
    await seedJob('job-r1c', { status: 'running' })
    await getDb().insert(jobTasks).values({
      jobId: 'job-r1c',
      taskId: 'task-c',
      title: 'C',
      sortOrder: 0,
      status: 'running',
      executionStatus: 'running'
    })
    const started = beginTaskAttempt({ jobId: 'job-r1c', taskId: 'task-c', runId: null })
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') throw new Error('unreachable')

    markRunningAttemptsInterruptedForJob('job-r1c')
    assert.throws(() =>
      commitCompletedTaskAttempt({
        jobId: 'job-r1c',
        taskId: 'task-c',
        attemptNo: started.attemptNo,
        result: { ok: true }
      })
    )

    const taskRow = getDb()
      .select({ status: jobTasks.status })
      .from(jobTasks)
      .where(and(eq(jobTasks.jobId, 'job-r1c'), eq(jobTasks.taskId, 'task-c')))
      .get()
    assert.equal(taskRow?.status, 'running')
  } finally {
    await teardownDb()
  }
})

test('F3-B: startup fence flips running/starting attempts to interrupted', async () => {
  await setupDb()
  try {
    await seedJob('job-x', { status: 'running' })
    const now = Math.floor(Date.now() / 1000)
    const k1 = deriveTaskIdempotencyKey({ jobId: 'job-x', taskId: 't1', snapshotPlanRevision: 0 })
    const k2 = deriveTaskIdempotencyKey({ jobId: 'job-x', taskId: 't2', snapshotPlanRevision: 0 })
    const k3 = deriveTaskIdempotencyKey({ jobId: 'job-x', taskId: 't3', snapshotPlanRevision: 0 })
    await getDb().insert(jobTaskAttempts).values([
      {
        id: 'a-run',
        jobId: 'job-x',
        taskId: 't1',
        runId: null,
        attemptNo: 1,
        idempotencyKey: k1,
        status: 'running',
        startedAt: now
      },
      {
        id: 'a-start',
        jobId: 'job-x',
        taskId: 't2',
        runId: null,
        attemptNo: 1,
        idempotencyKey: k2,
        status: 'starting',
        startedAt: now
      },
      {
        id: 'a-done',
        jobId: 'job-x',
        taskId: 't3',
        runId: null,
        attemptNo: 1,
        idempotencyKey: k3,
        status: 'completed',
        startedAt: now,
        endedAt: now
      }
    ])

    const changed = markAllRunningAttemptsInterrupted()
    assert.equal(changed, 2)

    const statuses = await getDb()
      .select({ id: jobTaskAttempts.id, status: jobTaskAttempts.status })
      .from(jobTaskAttempts)
      .where(eq(jobTaskAttempts.jobId, 'job-x'))
    const byId = new Map(statuses.map((row) => [row.id, row.status]))
    assert.equal(byId.get('a-run'), 'interrupted')
    assert.equal(byId.get('a-start'), 'interrupted')
    // Completed attempts are untouched.
    assert.equal(byId.get('a-done'), 'completed')

    // Per-job helper is a no-op once nothing is running.
    assert.equal(markRunningAttemptsInterruptedForJob('job-x'), 0)
  } finally {
    await teardownDb()
  }
})
