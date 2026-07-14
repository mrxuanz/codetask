import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import {
  deletionRequests,
  projects,
  threadJobs,
  threadMessages,
  threads,
  workloadRuns,
  workloadSlots
} from '../../src/server/db/schema'
import {
  drainAndDeleteJob,
  executeDeletionRequest,
  isEntityDeletionBlocked,
  isThreadProjectDeletionBlocked,
  resumePendingDeletionRequestsOnStartup,
  resetDeletionCoordinatorForTests,
  setDeletionPurgeHooksForTests
} from '../../src/server/legacy-control-plane/deletion-coordinator'
import { resetJobReconcileForTests, stopWorkloadReconcilerForTests } from '../../src/server/legacy-control-plane/reconcile'
import { ensureStartupWorkloadReady } from '../../src/server/legacy-control-plane/workload-slot'
import { resetWorkspaceLeaseStateForTests } from '../../src/server/legacy-control-plane/workspace-lease-store'
import { resetWorkloadRunControllersForTests } from '../../src/server/legacy-control-plane/workload-slot-store'
import { resetRuntimeSupervisorForTests } from '../../src/server/legacy-control-plane/runtime-supervisor'
import { jobRuntimeDir } from '../../src/server/runtime/cleanup'

let dataDir = ''

async function setup(): Promise<void> {
  process.env.CODETASK_RUN_CANCEL_GRACE_MS = '0'
  process.env.CODETASK_RUN_KILL_GRACE_MS = '0'
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-delete-drain-'))
  await resetAppContextForTests()
  resetJobReconcileForTests()
  resetWorkspaceLeaseStateForTests()
  resetWorkloadRunControllersForTests()
  resetRuntimeSupervisorForTests()
  bootstrapRuntime({ dataDir })
  resetDeletionCoordinatorForTests()
  await ensureStartupWorkloadReady()
  stopWorkloadReconcilerForTests()
}

async function teardown(): Promise<void> {
  setDeletionPurgeHooksForTests({})
  stopWorkloadReconcilerForTests()
  resetJobReconcileForTests()
  resetWorkloadRunControllersForTests()
  resetRuntimeSupervisorForTests()
  await resetAppContextForTests()
  resetWorkspaceLeaseStateForTests()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

async function seedPendingJob(jobId: string): Promise<{ threadId: string; runId: string; draftId: string }> {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const projectId = `proj-${jobId}`
  const threadId = `thread-${jobId}`
  const draftId = `draft-${jobId}`
  const workspaceRoot = join(dataDir, 'ws')
  mkdirSync(workspaceRoot, { recursive: true })
  const runId = `wrun-${jobId}`

  await db.insert(projects).values({
    id: projectId,
    username: 'user',
    title: 'P',
    workspaceRoot,
    createdAt: now,
    updatedAt: now
  })
  await db.insert(threads).values({
    id: threadId,
    username: 'user',
    projectId,
    title: 'T',
    status: 'draft',
    conversationId: `conv-${threadId}`,
    coreCode: 'cursorcli',
    runtimeStatus: 'idle',
    coreRuntimeJson: '{}',
    threadKind: 'create_task',
    wizardPhase: 'collect',
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
    coreCode: 'cursorcli',
    conversationId: `conv-${threadId}`,
    payloadJson: '{}',
    createdAt: String(now)
  })
  await db.insert(threadJobs).values({
    id: jobId,
    threadId,
    username: 'user',
    draftMessageId: draftId,
    title: 'Job',
    summary: '',
    status: 'running',
    workspacePath: workspaceRoot,
    planConfirmedAt: now,
    activeRunId: runId,
    createdAt: now,
    updatedAt: now
  })
  await db.insert(workloadRuns).values({
    id: runId,
    username: 'user',
    ownerKind: 'thread_job',
    ownerId: jobId,
    kind: 'execution',
    pool: 'execution',
    status: 'active',
    startedAt: now,
    updatedAt: now
  })
  await db.insert(workloadSlots).values({
    runId,
    username: 'user',
    pool: 'execution',
    ownerKind: 'thread_job',
    ownerId: jobId,
    kind: 'execution',
    status: 'active',
    createdAt: now
  })

  return { threadId, runId, draftId }
}

test('drainAndDeleteJob freezes run identity and completes phased deletion', async () => {
  await setup()
  try {
    const jobId = 'job-delete-drain'
    const { runId } = await seedPendingJob(jobId)
    const db = getDb()

    await drainAndDeleteJob('user', jobId)

    const jobRows = await db.select().from(threadJobs).where(eq(threadJobs.id, jobId))
    assert.equal(jobRows.length, 0)

    const runRows = await db.select().from(workloadRuns).where(eq(workloadRuns.id, runId))
    assert.ok(runRows[0])
    assert.equal(runRows[0]?.status, 'released')

    const delRows = await db
      .select()
      .from(deletionRequests)
      .where(eq(deletionRequests.entityId, jobId))
    assert.equal(delRows[0]?.phase, 'completed')
    assert.equal(delRows[0]?.status, 'completed')
    assert.ok(delRows[0]?.frozenJson?.includes(runId))
    assert.ok(delRows[0]?.cleanupTargetsJson?.includes(jobId))
  } finally {
    await teardown()
  }
})

test('executeDeletionRequest resumes filesystem purge after database_deleted without live job row', async () => {
  await setup()
  try {
    const jobId = 'job-resume-fs'
    const { threadId, runId, draftId } = await seedPendingJob(jobId)
    const db = getDb()
    const runtimePath = jobRuntimeDir(dataDir, threadId, jobId)
    mkdirSync(runtimePath, { recursive: true })
    writeFileSync(join(runtimePath, 'marker.txt'), 'keep')

    const now = Math.floor(Date.now() / 1000)
    const requestId = 'del-resume-fs-test'
    await db.insert(deletionRequests).values({
      id: requestId,
      entityKind: 'thread_job',
      entityId: jobId,
      username: 'user',
      status: 'draining',
      phase: 'database_deleted',
      threadId,
      projectId: `proj-${jobId}`,
      workspacePath: join(dataDir, 'ws'),
      frozenJson: JSON.stringify({
        runtime: {
          activeRunId: runId,
          executionLeaseOwner: null,
          workspaceLeaseOwnerKind: 'thread_job',
          workspaceLeaseOwnerId: jobId
        },
        draftMessageId: draftId
      }),
      cleanupTargetsJson: JSON.stringify({ kind: 'job', threadId, jobId }),
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    })

    await db.delete(threadJobs).where(eq(threadJobs.id, jobId)).run()
    assert.equal(existsSync(join(runtimePath, 'marker.txt')), true)

    await executeDeletionRequest(requestId)

    assert.equal(existsSync(runtimePath), false)
    const delRows = await db
      .select()
      .from(deletionRequests)
      .where(eq(deletionRequests.id, requestId))
    assert.equal(delRows[0]?.phase, 'completed')
    assert.equal(delRows[0]?.status, 'completed')
  } finally {
    await teardown()
  }
})

test('resumePendingDeletionRequestsOnStartup resumes by requestId and phase snapshot', async () => {
  await setup()
  try {
    const jobId = 'job-startup-resume'
    const { threadId, runId, draftId } = await seedPendingJob(jobId)
    const db = getDb()
    const runtimePath = jobRuntimeDir(dataDir, threadId, jobId)
    mkdirSync(runtimePath, { recursive: true })
    writeFileSync(join(runtimePath, 'startup-marker.txt'), 'pending')

    const now = Math.floor(Date.now() / 1000)
    const requestId = 'del-startup-resume'
    await db.insert(deletionRequests).values({
      id: requestId,
      entityKind: 'thread_job',
      entityId: jobId,
      username: 'user',
      status: 'draining',
      phase: 'database_deleted',
      threadId,
      frozenJson: JSON.stringify({
        runtime: {
          activeRunId: runId,
          executionLeaseOwner: null,
          workspaceLeaseOwnerKind: 'thread_job',
          workspaceLeaseOwnerId: jobId
        },
        draftMessageId: draftId
      }),
      cleanupTargetsJson: JSON.stringify({ kind: 'job', threadId, jobId }),
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    })
    await db.delete(threadJobs).where(eq(threadJobs.id, jobId)).run()

    await resumePendingDeletionRequestsOnStartup()

    assert.equal(existsSync(runtimePath), false)
    const delRows = await db
      .select()
      .from(deletionRequests)
      .where(eq(deletionRequests.id, requestId))
    assert.equal(delRows[0]?.phase, 'completed')
  } finally {
    await teardown()
  }
})

test('filesystem purge failure keeps deletion incomplete and does not mark completed', async () => {
  await setup()
  try {
    const jobId = 'job-fs-fail'
    const { threadId, runId, draftId } = await seedPendingJob(jobId)
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    const requestId = 'del-fs-fail'
    await db.insert(deletionRequests).values({
      id: requestId,
      entityKind: 'thread_job',
      entityId: jobId,
      username: 'user',
      status: 'draining',
      phase: 'database_deleted',
      threadId,
      frozenJson: JSON.stringify({
        runtime: {
          activeRunId: runId,
          executionLeaseOwner: null,
          workspaceLeaseOwnerKind: 'thread_job',
          workspaceLeaseOwnerId: jobId
        },
        draftMessageId: draftId
      }),
      cleanupTargetsJson: JSON.stringify({
        kind: 'job',
        threadId,
        jobId: 'nonexistent-job-id-for-fault'
      }),
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    })
    await db.delete(threadJobs).where(eq(threadJobs.id, jobId)).run()

    setDeletionPurgeHooksForTests({
      purgeJob: async () => {
        throw new Error('simulated filesystem purge failure')
      }
    })

    try {
      await assert.rejects(() => executeDeletionRequest(requestId), /simulated filesystem purge failure/)
    } finally {
      setDeletionPurgeHooksForTests({})
    }

    const delRows = await db
      .select()
      .from(deletionRequests)
      .where(eq(deletionRequests.id, requestId))
    assert.equal(delRows[0]?.phase, 'database_deleted')
    assert.notEqual(delRows[0]?.status, 'completed')
    assert.equal(delRows[0]?.retryCount, 1)
    assert.match(delRows[0]?.lastError ?? '', /simulated filesystem purge failure/)
    assert.equal(isEntityDeletionBlocked('thread_job', jobId), true)
  } finally {
    await teardown()
  }
})

test('incomplete deletion blocks thread turns and job lease admission', async () => {
  await setup()
  try {
    const jobId = 'job-blocked'
    const { threadId } = await seedPendingJob(jobId)
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)

    await db.insert(deletionRequests).values({
      id: 'del-blocked',
      entityKind: 'thread_job',
      entityId: jobId,
      username: 'user',
      status: 'draining',
      phase: 'draining',
      threadId,
      frozenJson: '{}',
      cleanupTargetsJson: JSON.stringify({ kind: 'job', threadId, jobId }),
      retryCount: 0,
      createdAt: now,
      updatedAt: now
    })

    assert.equal(isEntityDeletionBlocked('thread_job', jobId), true)
    assert.equal(await isThreadProjectDeletionBlocked(threadId), true)

    const { claimExecutionSlotForJobTx } = await import(
      '../../src/server/legacy-control-plane/workload-slot-store'
    )
    const claim = await claimExecutionSlotForJobTx('user', jobId)
    assert.equal(claim, null)
  } finally {
    await teardown()
  }
})
