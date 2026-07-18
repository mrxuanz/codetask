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
  authorizeUncertainTaskAttemptReplayForJob,
  beginTaskAttempt,
  commitCompletedTaskAttempt,
  deriveIdempotencyKey,
  deriveTaskIdempotencyKey,
  hasCompletedAttempt,
  markAllRunningAttemptsInterrupted,
  markTaskAttemptProviderStarted,
  markRunningAttemptsInterruptedForJob
} from '../../src/server/legacy-control-plane/task-attempts'
import {
  jobTaskAttempts,
  jobTasks,
  projects,
  threadJobs,
  threadMessages,
  threads,
  workloadRuns
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
    await getDb().insert(jobTasks).values({
      jobId: 'job-paused',
      taskId: 't1',
      title: 'T1',
      sortOrder: 0,
      status: 'completed',
      executionStatus: 'completed'
    })
    await getDb()
      .update(threadJobs)
      .set({
        lastError: JSON.stringify({
          v: 1,
          code: 'job.paused',
          message: 'Job paused',
          detail: null
        }),
        taskPhase: 'running',
        taskStatus: 'running',
        taskCurrentIndex: 1,
        taskTotal: 2
      })
      .where(eq(threadJobs.id, 'job-paused'))

    await reconcileOrphanRunningJobsForUser('user')

    assert.equal(await jobStatus('job-paused'), 'paused')
  } finally {
    await teardownDb()
  }
})

test('F3-A: legacy restart-looking paused stays paused after P7 (no heuristic auto-resume)', async () => {
  await setupDb()
  try {
    await seedJob('job-restart-paused', { status: 'paused' })
    await getDb()
      .insert(jobTasks)
      .values([
        {
          jobId: 'job-restart-paused',
          taskId: 't1',
          title: 'T1',
          sortOrder: 0,
          status: 'completed',
          executionStatus: 'completed'
        },
        {
          jobId: 'job-restart-paused',
          taskId: 't2',
          title: 'T2',
          sortOrder: 1,
          status: 'queued',
          executionStatus: 'queued'
        }
      ])
    await getDb()
      .update(threadJobs)
      .set({
        lastError: null,
        taskPhase: 'running',
        taskStatus: 'running',
        taskCurrentIndex: 1,
        taskTotal: 2,
        taskCurrentTaskId: 't2',
        taskMetaJson: JSON.stringify({
          slices: [{ id: 'm1-s1', runtimeStatus: 'running', verificationStatus: null }]
        })
      })
      .where(eq(threadJobs.id, 'job-restart-paused'))

    beginDraining()
    await reconcileOrphanRunningJobsForUser('user')

    // P7: long-term heuristic removed; one-time promotion is migration 039 → pending.
    assert.equal(await jobStatus('job-restart-paused'), 'paused')
  } finally {
    await teardownDb()
  }
})

test('continue intent survives a pausing restart and settles to pending exactly once', async () => {
  await setupDb()
  try {
    await seedJob('job-pausing-continue', { status: 'pausing' })
    await getDb()
      .update(threadJobs)
      .set({
        continueAfterPause: 1,
        suspensionKind: 'user_pause',
        taskPhase: 'running',
        taskStatus: 'running',
        taskCurrentIndex: 0,
        taskTotal: 1
      })
      .where(eq(threadJobs.id, 'job-pausing-continue'))

    beginDraining()
    await reconcileOrphanRunningJobsForUser('user')

    const row = getDb()
      .select({
        status: threadJobs.status,
        continueAfterPause: threadJobs.continueAfterPause,
        taskStatus: threadJobs.taskStatus
      })
      .from(threadJobs)
      .where(eq(threadJobs.id, 'job-pausing-continue'))
      .get()
    assert.equal(row?.status, 'pending')
    assert.equal(row?.continueAfterPause, 0)
    assert.equal(row?.taskStatus, 'pending')

    await reconcileOrphanRunningJobsForUser('user')
    assert.equal(await jobStatus('job-pausing-continue'), 'pending')
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

    markTaskAttemptProviderStarted({
      jobId: 'job-att',
      taskId: 'task-1',
      attemptNo: first.attemptNo
    })

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

test('R1: pre-provider retry keeps its key; uncertain Provider outcome blocks replay', async () => {
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

    // The attempt has not crossed the Provider boundary, so recovery may safely retry it.
    markRunningAttemptsInterruptedForJob('job-r1')
    const now = Math.floor(Date.now() / 1000)
    await getDb().insert(workloadRuns).values({
      id: 'run-controlled-retry',
      username: 'user',
      ownerKind: 'thread_job',
      ownerId: 'job-r1',
      kind: 'execution',
      pool: 'execution',
      status: 'active',
      startedAt: now,
      updatedAt: now
    })
    const retry = beginTaskAttempt({
      jobId: 'job-r1',
      taskId: 'task-a',
      runId: 'run-controlled-retry',
      snapshotPlanRevision: 3
    })
    assert.equal(retry.kind, 'started')
    if (retry.kind !== 'started') throw new Error('unreachable')
    assert.equal(retry.attemptNo, 2)
    assert.equal(retry.idempotencyKey, key)

    markTaskAttemptProviderStarted({
      jobId: 'job-r1',
      taskId: 'task-a',
      attemptNo: retry.attemptNo
    })

    const sameRun = beginTaskAttempt({
      jobId: 'job-r1',
      taskId: 'task-a',
      runId: 'run-controlled-retry',
      snapshotPlanRevision: 3
    })
    assert.equal(sameRun.kind, 'resumed')
    if (sameRun.kind !== 'resumed') throw new Error('unreachable')
    assert.equal(sameRun.attemptNo, retry.attemptNo)
    assert.equal(sameRun.idempotencyKey, key)

    markRunningAttemptsInterruptedForJob('job-r1')

    const blocked = beginTaskAttempt({
      jobId: 'job-r1',
      taskId: 'task-a',
      runId: null,
      snapshotPlanRevision: 3
    })
    assert.equal(blocked.kind, 'blocked-uncertain')
    if (blocked.kind !== 'blocked-uncertain') throw new Error('unreachable')
    assert.equal(blocked.attemptNo, 2)
    assert.equal(blocked.idempotencyKey, key)

    assert.equal(authorizeUncertainTaskAttemptReplayForJob('job-r1'), 1)
    const authorized = beginTaskAttempt({
      jobId: 'job-r1',
      taskId: 'task-a',
      runId: null,
      snapshotPlanRevision: 3
    })
    assert.equal(authorized.kind, 'started')
    if (authorized.kind !== 'started') throw new Error('unreachable')
    assert.equal(authorized.attemptNo, 3)
    assert.equal(authorized.idempotencyKey, key)

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

    markTaskAttemptProviderStarted({
      jobId: 'job-r1c',
      taskId: 'task-c',
      attemptNo: started.attemptNo
    })

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
    await getDb()
      .insert(jobTaskAttempts)
      .values([
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
      .select({
        id: jobTaskAttempts.id,
        status: jobTaskAttempts.status,
        idempotencyKey: jobTaskAttempts.idempotencyKey
      })
      .from(jobTaskAttempts)
      .where(eq(jobTaskAttempts.jobId, 'job-x'))
    const byId = new Map(statuses.map((row) => [row.id, row.status]))
    assert.equal(byId.get('a-run'), 'interrupted')
    assert.equal(byId.get('a-start'), 'interrupted')
    // Completed attempts are untouched.
    assert.equal(byId.get('a-done'), 'completed')

    const keysById = new Map(statuses.map((row) => [row.id, row.idempotencyKey]))
    // A Provider-started attempt keeps the stable key as its replay fence. A pre-provider attempt
    // receives a diagnostic suffix, freeing the stable key for a safe retry.
    assert.equal(keysById.get('a-run'), k1)
    assert.match(keysById.get('a-start') ?? '', /^.+:interrupted-safe:1$/u)

    // Per-job helper is a no-op once nothing is running.
    assert.equal(markRunningAttemptsInterruptedForJob('job-x'), 0)
  } finally {
    await teardownDb()
  }
})

test('F3-A: uncertain fence stays blocked until explicit user authorize (no silent auto-resume)', async () => {
  await setupDb()
  try {
    const { prepareInterruptedJobForUserContinue } =
      await import('../../src/server/legacy-control-plane/queue-coordinator')
    const { jobHasUncertainReplayFence } =
      await import('../../src/server/legacy-control-plane/task-attempts')

    await seedJob('job-auto', { status: 'running' })
    await getDb().insert(jobTasks).values({
      jobId: 'job-auto',
      taskId: 'task-1',
      title: 'T1',
      sortOrder: 0,
      status: 'running',
      executionStatus: 'running'
    })

    const started = beginTaskAttempt({
      jobId: 'job-auto',
      taskId: 'task-1',
      runId: null,
      snapshotPlanRevision: 1
    })
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') throw new Error('unreachable')

    markTaskAttemptProviderStarted({
      jobId: 'job-auto',
      taskId: 'task-1',
      attemptNo: started.attemptNo
    })
    markRunningAttemptsInterruptedForJob('job-auto')

    const blocked = beginTaskAttempt({
      jobId: 'job-auto',
      taskId: 'task-1',
      runId: null,
      snapshotPlanRevision: 1
    })
    assert.equal(blocked.kind, 'blocked-uncertain')
    assert.equal(jobHasUncertainReplayFence('job-auto'), true)

    // Explicit Continue-path authorization clears the fence.
    assert.equal(prepareInterruptedJobForUserContinue('job-auto'), 1)
    assert.equal(jobHasUncertainReplayFence('job-auto'), false)

    const resumed = beginTaskAttempt({
      jobId: 'job-auto',
      taskId: 'task-1',
      runId: null,
      snapshotPlanRevision: 1
    })
    assert.equal(resumed.kind, 'started')
  } finally {
    await teardownDb()
  }
})
