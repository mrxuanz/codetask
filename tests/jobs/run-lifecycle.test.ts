import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase, closeDatabaseForTests, getDb } from '../../src/server/db'
import { threadJobs, threadMessages, threads, projects } from '../../src/server/db/schema'
import {
  claimWorkloadSlotTx,
  getActiveRun,
  resetWorkloadRunControllersForTests
} from '../../src/server/jobs/workload-slot-store'
import {
  finishPlanningRunLifecycle,
  stopRunLifecycle
} from '../../src/server/jobs/run-lifecycle'
import { registerRunRuntime, resetRuntimeSupervisorForTests } from '../../src/server/jobs/runtime-supervisor'

let dataDir: string

function setupDb(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-run-lifecycle-'))
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
  resetRuntimeSupervisorForTests()
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
  setupDb()
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
    teardownDb()
  }
})

test('finishPlanningRunLifecycle failure runs stop lifecycle with injectable deps', async () => {
  setupDb()
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
    teardownDb()
  }
})

test('finishPlanningRunLifecycle skips release when run already released', async () => {
  setupDb()
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
    teardownDb()
  }
})
