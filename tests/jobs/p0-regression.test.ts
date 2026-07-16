import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import { bootstrapRuntime, resetAppContextForTests, getAppContext } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import { jobTasks, threadJobs } from '../../src/server/db/schema'
import { updateJobRow, isStaleExecutionLeaseOwner, executionLeaseOwner } from '../../src/server/legacy-control-plane/repository'
import { cleanupJobRuntimeTree, jobRuntimeDir } from '../../src/server/runtime/cleanup'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { readRetentionSettings } from '../../src/server/retention/settings'
import { getExecutionRunContext } from '../../src/server/legacy-control-plane/execution-run-context'
import { seedJobGraph } from '../helpers/seed-job-graph'

const USERNAME = 'txn-test-user'
const JOB_ID = 'job-txn-atomic-test'
const THREAD_ID = 'thread-txn'
const DRAFT_ID = 'msg-txn'

describe('write path transaction atomicity', () => {
  let dataDir: string

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'codetask-p0-txn-'))
    await resetAppContextForTests()
    bootstrapRuntime({ dataDir })

    await seedJobGraph(getDb(), {
      jobId: JOB_ID,
      username: USERNAME,
      threadId: THREAD_ID,
      draftMessageId: DRAFT_ID,
      status: 'running',
      workspacePath: dataDir
    })
  })

  after(async () => {
    await resetAppContextForTests()
    if (dataDir) {
      try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* best-effort */ }
    }
  })

  it('updateJobRow writes all fields atomically', async () => {
    const result = await updateJobRow(JOB_ID, {
      status: 'failed',
      planProgress: {
        phase: 'idle',
        status: 'failed',
        contextsRegistered: 0,
        contextsTotal: 0,
        progressCode: 'plan.failed',
        progressParams: null,
        message: null
      },
      taskProgress: {
        phase: 'idle',
        status: 'pending',
        currentIndex: 0,
        total: 0,
        currentTaskId: null,
        message: null,
        tasks: [
          {
            id: 't1',
            title: 'Test task',
            status: 'failed',
            executionStatus: 'failed',
            evidenceStatus: null,
            errorMessage: null,
            abilityCode: 'code',
            coreCode: null
          }
        ]
      },
      lastError: 'test error'
    })

    assert.ok(result, 'job should exist after update')

    const db = getDb()
    const job = db.select().from(threadJobs).where(eq(threadJobs.id, JOB_ID)).limit(1).all()[0]
    assert.equal(job?.status, 'failed')
    assert.equal(job?.planStatus, 'failed')
    assert.ok(job?.lastError?.includes('test error'))

    const tasks = db.select().from(jobTasks).where(eq(jobTasks.jobId, JOB_ID)).all()
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].taskId, 't1')
    assert.equal(tasks[0].status, 'failed')
  })
})

describe('terminal runtime cleanup', () => {
  let dataDir: string

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'codetask-p0-cleanup-'))
    await resetAppContextForTests()
    bootstrapRuntime({ dataDir })

    await seedJobGraph(getDb(), {
      jobId: 'job-cleanup-test',
      username: USERNAME,
      threadId: 'thread-cleanup',
      draftMessageId: 'msg-cleanup',
      status: 'completed',
      workspacePath: dataDir
    })

    const runtimeDir = jobRuntimeDir(dataDir, 'thread-cleanup', 'job-cleanup-test')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'test.txt'), 'test content')
    assert.ok(existsSync(runtimeDir), 'runtime dir should exist before cleanup')
  })

  after(async () => {
    await resetAppContextForTests()
    if (dataDir) {
      try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* best-effort */ }
    }
  })

  it('terminal job runtime is deleted after cleanup', async () => {
    const settings = readRetentionSettings(getAppContext().settings)
    assert.ok(settings.runtimeTerminalImmediate, 'runtimeTerminalImmediate should be true by default')

    await cleanupJobRuntimeTree(dataDir, 'thread-cleanup', 'job-cleanup-test')

    const runtimeDir = jobRuntimeDir(dataDir, 'thread-cleanup', 'job-cleanup-test')
    assert.equal(existsSync(runtimeDir), false, 'runtime dir should be deleted after cleanup')
  })

  it('non-terminal job runtime is NOT deleted', async () => {
    const db = getDb()
    await db.update(threadJobs)
      .set({ status: 'running' })
      .where(eq(threadJobs.id, 'job-cleanup-test'))

    const runtimeDir = jobRuntimeDir(dataDir, 'thread-cleanup', 'job-cleanup-test')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'test2.txt'), 'alive')
    assert.ok(existsSync(runtimeDir))

    const { cleanupJobRuntimeTreeIfTerminal } = await import('../../src/server/runtime/cleanup')
    const result = await cleanupJobRuntimeTreeIfTerminal(
      dataDir,
      'thread-cleanup',
      'job-cleanup-test',
      'running'
    )
    assert.equal(result, 'skipped_non_terminal')
    assert.ok(existsSync(runtimeDir), 'running job runtime should not be deleted')
  })

  it('defers cleanup while execution loop is active instead of throwing', async () => {
    const db = getDb()
    await db
      .update(threadJobs)
      .set({ status: 'failed' })
      .where(eq(threadJobs.id, 'job-cleanup-test'))

    const runtimeDir = jobRuntimeDir(dataDir, 'thread-cleanup', 'job-cleanup-test')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'deferred.txt'), 'still-running')

    const ctx = getAppContext()
    assert.equal(ctx.executionRuntime.tryStartLoop('job-cleanup-test', USERNAME), true)
    try {
      const result = await cleanupJobRuntimeTree(dataDir, 'thread-cleanup', 'job-cleanup-test')
      assert.equal(result, 'deferred_active')
      assert.ok(existsSync(runtimeDir), 'runtime must remain while loop is active')
    } finally {
      ctx.executionRuntime.endLoop('job-cleanup-test')
    }

    const after = await cleanupJobRuntimeTree(dataDir, 'thread-cleanup', 'job-cleanup-test')
    assert.equal(after, 'deleted')
    assert.equal(existsSync(runtimeDir), false)
  })
})

describe('PID reuse zombie detection with bootId', () => {
  let dataDir: string

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'codetask-p0-pid-'))
    await resetAppContextForTests()
    bootstrapRuntime({ dataDir })
  })

  after(async () => {
    await resetAppContextForTests()
    if (dataDir) {
      try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* best-effort */ }
    }
  })

  it('same PID different bootId is detected as stale', () => {
    const ownOwner = executionLeaseOwner()
    const [pid] = ownOwner.split('-')
    const fakeOwner = `${pid}-00000000-0000-4000-8000-000000000042`

    assert.ok(isStaleExecutionLeaseOwner(fakeOwner), 'same PID with different bootId should be stale')
    assert.equal(isStaleExecutionLeaseOwner(ownOwner), false, 'own owner should not be stale')
    assert.equal(isStaleExecutionLeaseOwner(null), false, 'null should not be stale')
  })

  it('legacy pid-only format is not stale (conservative)', () => {
    assert.equal(isStaleExecutionLeaseOwner('pid-12345'), false)
    assert.equal(isStaleExecutionLeaseOwner('99999-oldboot'), false)
  })
})

describe('evidence hydrate with large objects', () => {
  let dataDir: string

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'codetask-p0-evidence-'))
    await resetAppContextForTests()
    bootstrapRuntime({ dataDir })
  })

  after(async () => {
    await resetAppContextForTests()
    if (dataDir) {
      try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* best-effort */ }
    }
  })

  it('evidence exceeding 5MB is truncated', async () => {
    const { MAX_TASK_EVIDENCE_BYTES } = await import('../../src/server/legacy-control-plane/evidence/store')
    const largeEvidence = {
      status: 'completed' as const,
      summary: 'test',
      changedFiles: [],
      evidence: Array.from({ length: 200000 }, (_, i) => `line ${i}: ${'x'.repeat(40)}`),
      validation: { status: 'passed', summary: '', errors: [] }
    }
    const json = JSON.stringify(largeEvidence)
    const byteSize = Buffer.byteLength(json, 'utf8')
    assert.ok(byteSize > MAX_TASK_EVIDENCE_BYTES, 'evidence should exceed limit')

    const { truncateEvidence } = await import('../../src/server/legacy-control-plane/evidence/store')
    const truncated = truncateEvidence(largeEvidence)
    assert.ok(truncated.evidence.length <= 1000, 'evidence lines should be truncated')
  })
})

describe('keepalive cross-process awareness', () => {
  it('confirms getExecutionRunContext is undefined outside runWithExecutionRunContext', async () => {
    const { getExecutionRunContext, runWithExecutionRunContext } = await import(
      '../../src/server/legacy-control-plane/execution-run-context'
    )
    assert.equal(getExecutionRunContext(), undefined, 'should be undefined when not in context')

    let ctxInside: string | undefined
    await runWithExecutionRunContext(
      { runId: 'test-run-id', signal: new AbortController().signal },
      async () => {
        ctxInside = getExecutionRunContext()?.runId
      }
    )
    assert.equal(ctxInside, 'test-run-id', 'should have runId inside context')
  })

  it('documents that role-worker keepalive is broken by design', () => {
    assert.equal(getExecutionRunContext(), undefined)
  })
})
