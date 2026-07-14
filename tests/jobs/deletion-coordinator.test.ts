import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
import { drainAndDeleteJob } from '../../src/server/legacy-control-plane/deletion-coordinator'
import { resetJobReconcileForTests, stopWorkloadReconcilerForTests } from '../../src/server/legacy-control-plane/reconcile'
import { ensureStartupWorkloadReady } from '../../src/server/legacy-control-plane/workload-slot'
import { resetWorkspaceLeaseStateForTests } from '../../src/server/legacy-control-plane/workspace-lease-store'
import { resetWorkloadRunControllersForTests } from '../../src/server/legacy-control-plane/workload-slot-store'
import { resetRuntimeSupervisorForTests } from '../../src/server/legacy-control-plane/runtime-supervisor'

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
  await ensureStartupWorkloadReady()
  stopWorkloadReconcilerForTests()
}

async function teardown(): Promise<void> {
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

async function seedPendingJob(jobId: string): Promise<{ threadId: string; runId: string }> {
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

  return { threadId, runId }
}

test('drainAndDeleteJob freezes run identity and drains before deleting owner row', async () => {
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
    assert.equal(delRows[0]?.status, 'completed')
    assert.ok(delRows[0]?.frozenJson?.includes(runId))
  } finally {
    await teardown()
  }
})
