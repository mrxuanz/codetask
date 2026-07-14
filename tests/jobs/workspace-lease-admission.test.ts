import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import { projects, threadJobs, threadMessages, threads, workspaceLeases } from '../../src/server/db/schema'
import {
  resetJobReconcileForTests,
  stopWorkloadReconcilerForTests
} from '../../src/server/legacy-control-plane/reconcile'
import { ensureStartupWorkloadReady } from '../../src/server/legacy-control-plane/workload-slot'
import {
  claimExecutionSlotForJobTx,
  resetWorkloadRunControllersForTests
} from '../../src/server/legacy-control-plane/workload-slot-store'
import {
  acquireWorkspaceLease,
  findWorkspaceLeaseConflict,
  normalizeWorkspaceLeasePath,
  releaseWorkspaceLease,
  releaseWorkspaceLeaseForOwner,
  resetWorkspaceLeaseStateForTests
} from '../../src/server/legacy-control-plane/workspace-lease-store'

const executorPath = join(process.cwd(), 'src/server/legacy-control-plane/executor.ts')
const queueCoordinatorPath = join(process.cwd(), 'src/server/legacy-control-plane/queue-coordinator.ts')

let dataDir = ''
let workspaceRoot = ''

async function setup(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-ws-lease-admission-'))
  workspaceRoot = join(dataDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  await resetAppContextForTests()
  resetWorkspaceLeaseStateForTests()
  resetJobReconcileForTests()
  bootstrapRuntime({ dataDir })
  await ensureStartupWorkloadReady()
  stopWorkloadReconcilerForTests()
}

async function teardown(): Promise<void> {
  resetWorkloadRunControllersForTests()
  await resetAppContextForTests()
  resetWorkspaceLeaseStateForTests()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

async function seedPendingJob(jobId: string, workspacePath: string): Promise<void> {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const projectId = `proj-${jobId}`
  const threadId = `thread-${jobId}`
  const draftId = `draft-${jobId}`

  await db.insert(projects).values({
    id: projectId,
    username: 'user',
    title: 'P',
    workspaceRoot: workspacePath,
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
    status: 'pending',
    workspacePath,
    planConfirmedAt: now,
    createdAt: now,
    updatedAt: now
  })
}

async function activeLeaseCount(): Promise<number> {
  const rows = await getDb()
    .select({ id: workspaceLeases.id })
    .from(workspaceLeases)
    .where(eq(workspaceLeases.status, 'active'))
  return rows.length
}

test('releaseWorkspaceLease rejects stale runId and keeps lease active', async () => {
  await setup()
  try {
    const path = normalizeWorkspaceLeasePath(workspaceRoot)
    const acquired = acquireWorkspaceLease({
      workspacePath: path,
      ownerKind: 'thread_job',
      ownerId: 'job-1',
      runId: 'run-new'
    })
    assert.ok(acquired)

    const rejected = releaseWorkspaceLease({
      leaseId: acquired.leaseId,
      runId: 'run-old'
    })
    assert.equal(rejected, false)
    assert.equal(await activeLeaseCount(), 1)

    const accepted = releaseWorkspaceLease({
      leaseId: acquired.leaseId,
      runId: 'run-new'
    })
    assert.equal(accepted, true)
    assert.equal(await activeLeaseCount(), 0)
  } finally {
    await teardown()
  }
})

test('failed slot claim must not release winner lease for same job owner', async () => {
  await setup()
  try {
    const path = normalizeWorkspaceLeasePath(workspaceRoot)
    await seedPendingJob('job-a', path)

    const winnerLease = acquireWorkspaceLease({
      workspacePath: path,
      ownerKind: 'thread_job',
      ownerId: 'job-a'
    })
    assert.ok(winnerLease)

    const winnerSlot = await claimExecutionSlotForJobTx('user', 'job-a')
    assert.ok(winnerSlot)

    const loserLease = acquireWorkspaceLease({
      workspacePath: path,
      ownerKind: 'thread_job',
      ownerId: 'job-a'
    })
    assert.ok(loserLease)
    assert.equal(loserLease.leaseId, winnerLease.leaseId)

    const loserSlot = await claimExecutionSlotForJobTx('user', 'job-a')
    assert.equal(loserSlot, null)

    const jobRow = (
      await getDb().select().from(threadJobs).where(eq(threadJobs.id, 'job-a')).limit(1)
    )[0]
    assert.equal(jobRow?.status, 'running')

    if (jobRow?.status !== 'running') {
      releaseWorkspaceLease({ leaseId: loserLease.leaseId })
    }

    assert.equal(await activeLeaseCount(), 1)
    const conflict = findWorkspaceLeaseConflict(path)
    assert.ok(conflict)
    assert.equal(conflict?.leaseId, winnerLease.leaseId)
  } finally {
    await teardown()
  }
})

test('owner-only release on failed acquire path would drop a concurrent winner lease', async () => {
  await setup()
  try {
    const path = normalizeWorkspaceLeasePath(workspaceRoot)
    await seedPendingJob('job-a', path)

    const winnerLease = acquireWorkspaceLease({
      workspacePath: path,
      ownerKind: 'thread_job',
      ownerId: 'job-a'
    })
    assert.ok(winnerLease)
    assert.ok(await claimExecutionSlotForJobTx('user', 'job-a'))

    acquireWorkspaceLease({
      workspacePath: path,
      ownerKind: 'thread_job',
      ownerId: 'job-a'
    })
    assert.equal(await claimExecutionSlotForJobTx('user', 'job-a'), null)

    releaseWorkspaceLeaseForOwner('thread_job', 'job-a')
    assert.equal(await activeLeaseCount(), 0)
  } finally {
    await teardown()
  }
})

test('executeSingleTask fails closed before provider when lease is unavailable', () => {
  const source = readFileSync(executorPath, 'utf8')
  const fnStart = source.indexOf('async function executeSingleTask(')
  assert.ok(fnStart >= 0)

  const leaseLostIdx = source.indexOf("'workspace.lease_lost'", fnStart)
  const streamIdx = source.indexOf('streamAgentTurn(', fnStart)
  assert.ok(leaseLostIdx > fnStart)
  assert.ok(streamIdx > leaseLostIdx, 'lease check must precede provider streamAgentTurn call')
})

test('scheduleJobExecution does not owner-release lease on failed acquire', () => {
  const source = readFileSync(executorPath, 'utf8')
  const fnStart = source.indexOf('export function scheduleJobExecution(')
  assert.ok(fnStart >= 0)
  const fnEnd = source.indexOf('\n}', fnStart)
  const body = source.slice(fnStart, fnEnd)
  assert.doesNotMatch(body, /releaseWorkspaceLeaseForOwner/)
})

test('queue-coordinator releases lease by leaseId on slot failure', () => {
  const source = readFileSync(queueCoordinatorPath, 'utf8')
  assert.match(source, /releaseWorkspaceLease\(\{ leaseId: workspaceLease\.leaseId \}\)/)
  assert.doesNotMatch(source, /releaseWorkspaceLeaseForOwner/)
})
