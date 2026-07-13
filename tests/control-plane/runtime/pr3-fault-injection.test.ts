import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { runMigrations } from '../../../src/server/db/migrations/runner'
import { allMigrations } from '../../../src/server/db/migrations/index'
import { controlPlaneSchema } from '../../../src/server/infra/sqlite/control-plane/schema'
import { SqliteJobRepository } from '../../../src/server/infra/sqlite/control-plane/job-repository'
import { SqliteTaskRepository } from '../../../src/server/infra/sqlite/control-plane/task-repository'
import { EvidenceRepository } from '../../../src/server/infra/sqlite/control-plane/evidence-repository'
import { JobCommandServiceImpl } from '../../../src/server/application/job-command-service'
import { InternalExecutionCommandServiceImpl } from '../../../src/server/application/internal-execution-command-service'
import { VerificationRepository } from '../../../src/server/infra/sqlite/control-plane/verification-repository'
import { StartupReconciler } from '../../../src/server/application/startup-reconciler-impl'
import { StartupCoordinator } from '../../../src/server/application/startup-coordinator'
import { SafeLoggerImpl } from '../../../src/server/application/safe-logger'
import type { RuntimeController } from '../../../src/server/application/ports/runtime-controller'
import { seedOwnedThreadJob } from '../fixtures/seed-owned-thread-job'

/**
 * C7–C9 PR3 fault-injection windows (implementation guide §9.7).
 */

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db, allMigrations)
  return db
}

function seedJob(
  db: Database.Database,
  opts: {
    username?: string
    state: string
    stateRevision?: number
    controlIntent?: string
    activeRunId?: string | null
    resumeTarget?: string | null
  }
): void {
  const now = Date.now()
  const jobId = 'job-1'
  seedOwnedThreadJob(db, {
    jobId,
    username: opts.username ?? 'u1',
    status: opts.state === 'execution_running' ? 'running' : 'pending'
  })
  db.prepare(
    `INSERT INTO control_jobs (
      id, thread_id, project_id, draft_message_id, state, state_revision,
      control_intent, resume_target, execution_generation, active_run_id, title, requirements_summary,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    jobId,
    `thread-${jobId}`,
    `project-${jobId}`,
    `draft-${jobId}`,
    opts.state,
    opts.stateRevision ?? 1,
    opts.controlIntent ?? 'none',
    opts.resumeTarget ?? null,
    0,
    opts.activeRunId ?? null,
    'Test',
    '',
    now,
    now
  )
}

function seedRun(db: Database.Database, opts: { state?: string } = {}): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO control_job_runs (
      id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('run-1', 'job-1', 'execution', opts.state ?? 'active', 1, 'fence-1', 0, now)
}

function createServices(rawDb: Database.Database): {
  command: JobCommandServiceImpl
  internal: InternalExecutionCommandServiceImpl
  jobRepository: SqliteJobRepository
  runtimeStops: string[]
} {
  const drizzleDb = drizzle(rawDb, { schema: controlPlaneSchema })
  const jobRepository = new SqliteJobRepository(drizzleDb)
  const runtimeStops: string[] = []
  const runtimeController: RuntimeController = {
    notifyPauseRequested() {},
    async closeThenRelease(runId) {
      runtimeStops.push(runId)
    }
  }
  const command = new JobCommandServiceImpl({
    jobRepository,
    taskRepository: new SqliteTaskRepository(drizzleDb),
    evidenceRepository: new EvidenceRepository(drizzleDb),
    clock: { nowMs: () => 1_700_000_000_000 },
    idGenerator: { generate: () => randomUUID() },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    runtimeController
  })
  const internal = new InternalExecutionCommandServiceImpl({
    jobRepository,
    verificationRepository: new VerificationRepository(drizzleDb),
    evidenceRepository: new EvidenceRepository(drizzleDb),
    clock: { nowMs: () => 1_700_000_000_000 },
    idGenerator: { generate: () => randomUUID() },
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  })
  return { command, internal, jobRepository, runtimeStops }
}

describe('C7 kill windows', () => {
  let rawDb: Database.Database

  beforeEach(() => {
    rawDb = createTestDb()
  })

  it('pause before intent commit → crash settles recoverable failed (not paused)', async () => {
    seedJob(rawDb, { state: 'execution_running', activeRunId: 'run-1' })
    seedRun(rawDb, { state: 'interrupted' })
    const { jobRepository } = createServices(rawDb)
    const reconciler = new StartupReconciler(
      jobRepository,
      { nowMs: () => Date.now() },
      { generate: () => 'f1' },
      new SafeLoggerImpl()
    )
    await reconciler.reconcileAll()
    const job = jobRepository.getAggregate('job-1')
    assert.equal(job?.state, 'failed')
    assert.notEqual(job?.state, 'paused')
  })

  it('pause after intent commit, before ack → restart settles paused', async () => {
    seedJob(rawDb, {
      state: 'execution_running',
      activeRunId: 'run-1'
    })
    seedRun(rawDb)
    const { command, jobRepository } = createServices(rawDb)
    await command.requestPause({
      actor: { username: 'u1', requestId: 'r1' },
      jobId: 'job-1',
      expectedRevision: 1,
      idempotencyKey: randomUUID()
    })
    const mid = jobRepository.getOwnedAggregate({
      actor: { username: 'u1', requestId: '' },
      jobId: 'job-1'
    })
    assert.equal(mid?.state, 'pausing')
    assert.equal(mid?.controlIntent, 'pause')

    const reconciler = new StartupReconciler(
      jobRepository,
      { nowMs: () => Date.now() },
      { generate: () => 'f1' },
      new SafeLoggerImpl()
    )
    await reconciler.reconcileAll()
    const job = jobRepository.getAggregate('job-1')
    assert.equal(job?.state, 'paused')
  })

  it('cancel after commit, before abort → cancelled and run marked cancelling', async () => {
    seedJob(rawDb, { state: 'execution_running', activeRunId: 'run-1' })
    seedRun(rawDb)
    const { command, runtimeStops } = createServices(rawDb)
    const result = await command.cancelJob({
      actor: { username: 'u1', requestId: 'r1' },
      jobId: 'job-1',
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      payload: { reasonCode: 'user_cancelled' }
    })
    assert.equal(result.job.state, 'cancelled')
    assert.equal(result.runIdToStop, 'run-1')
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(runtimeStops, ['run-1'])
    const run = rawDb.prepare(`SELECT state FROM control_job_runs WHERE id = 'run-1'`).get() as {
      state: string
    }
    assert.equal(run.state, 'cancelling')
  })

  it('no intent crash → recoverable failed, not auto-claimed', async () => {
    seedJob(rawDb, {
      state: 'execution_running',
      activeRunId: 'run-1',
      controlIntent: 'none'
    })
    seedRun(rawDb, { state: 'interrupted' })
    const { jobRepository } = createServices(rawDb)
    const reconciler = new StartupReconciler(
      jobRepository,
      { nowMs: () => Date.now() },
      { generate: () => 'f1' },
      new SafeLoggerImpl()
    )
    await reconciler.reconcileAll()
    const job = jobRepository.getAggregate('job-1')
    assert.equal(job?.state, 'failed')
    assert.equal(job?.activeRunId, null)
  })
})

describe('C8 runtime child closed → RuntimeExited', () => {
  it('converges running job without leaving zombie active run', () => {
    const rawDb = createTestDb()
    seedJob(rawDb, { state: 'execution_running', activeRunId: 'run-1' })
    seedRun(rawDb)
    const { internal, jobRepository } = createServices(rawDb)
    const result = internal.runtimeExited({
      jobId: 'job-1',
      expectedRevision: 1,
      runId: 'run-1',
      fenceToken: 'fence-1',
      executionGeneration: 0,
      payload: { runtimeInstanceId: 'rt-1', exitKind: 'signal', signal: 'SIGTERM' }
    })
    assert.ok(result.decision === 'job_failed' || result.decision === 'retry_scheduled')
    const job = jobRepository.getAggregate('job-1')
    assert.notEqual(job?.state, 'execution_running')
    assert.equal(job?.activeRunId, null)
  })
})

describe('C9 EIO + StartupCoordinator reentry', () => {
  it('SafeLogger survives bad sink; coordinator retries after degraded', async () => {
    const logger = new SafeLoggerImpl({ logDir: '/nonexistent/cutover-eio' })
    assert.doesNotThrow(() => logger.error('eio'))

    let n = 0
    let scheduler = false
    const coordinator = new StartupCoordinator({
      logger,
      stages: [
        {
          name: 'reconcile',
          async execute() {
            n += 1
            if (n === 1) throw new Error('EIO')
          }
        },
        {
          name: 'scheduler',
          async execute() {
            scheduler = true
          }
        }
      ]
    })
    await assert.rejects(() => coordinator.ensureReady())
    assert.equal(coordinator.getPhase(), 'degraded')
    assert.equal(scheduler, false)
    await coordinator.ensureReady()
    assert.equal(coordinator.getPhase(), 'ready')
    assert.equal(scheduler, true)
  })
})
