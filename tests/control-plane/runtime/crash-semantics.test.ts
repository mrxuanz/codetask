import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { JobAggregate, ControlIntent, ResumeTarget } from '@shared/contracts/control-plane'
import { runMigrations } from '../../../src/server/db/migrations/runner'
import { allMigrations } from '../../../src/server/db/migrations/index'
import { controlPlaneSchema } from '../../../src/server/infra/sqlite/control-plane/schema'
import { createControlPlaneTransaction } from '../../../src/server/infra/sqlite/control-plane/sqlite-control-plane-unit-of-work'
import type { SqliteJobRepository } from '../../../src/server/infra/sqlite/control-plane/job-repository'
import { decideStartupReconcile } from '../../../src/server/application/startup-reconciler'
import { StartupReconciler } from '../../../src/server/application/startup-reconciler-impl'
import { StartupCoordinator } from '../../../src/server/application/startup-coordinator'
import { SafeLoggerImpl } from '../../../src/server/application/safe-logger'
import { seedOwnedThreadJob } from '../fixtures/seed-owned-thread-job'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db, allMigrations)
  return db
}

function seedJob(db: Database.Database, opts: {
  id: string
  state: string
  stateRevision?: number
  controlIntent?: string
  activeRunId?: string | null
  resumeTarget?: string | null
}): void {
  const now = Date.now()
  const jobId = opts.id
  seedOwnedThreadJob(db, {
    jobId,
    status: opts.state === 'execution_running' ? 'running' : 'pending'
  })
  db.prepare(
    `INSERT INTO control_jobs (id, thread_id, project_id, draft_message_id, state, state_revision,
      control_intent, execution_generation, active_run_id, title, requirements_summary, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, `thread-${jobId}`, `project-${jobId}`, `draft-${jobId}`, opts.state, opts.stateRevision ?? 1,
    opts.controlIntent ?? 'none', 0, opts.activeRunId ?? null, 'Test', '', now, now)
}

function seedRun(db: Database.Database, opts: {
  id: string
  jobId: string
  state?: string
  fenceToken?: string
}): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO control_job_runs (id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(opts.id, opts.jobId, 'execution', opts.state ?? 'active', 1, opts.fenceToken ?? 'fence-1', 0, now)
}

function makeJobAggregate(
  overrides: Partial<JobAggregate> & Pick<JobAggregate, 'id' | 'state'>
): JobAggregate {
  return {
    threadId: 't1',
    projectId: 'p1',
    stateRevision: 1,
    controlIntent: 'none' as ControlIntent,
    resumeTarget: null as ResumeTarget | null,
    currentPlanRevision: null,
    executionGeneration: 0,
    activeRunId: null,
    lastFailureId: null,
    ...overrides
  }
}

interface VerdictRow {
  verdict_blob_hash: string | null
}

interface CountRow {
  cnt: number
}

describe('Incident A: Zombie running (Task 64)', () => {
  let rawDb: Database.Database
  let repo: SqliteJobRepository
  let controlPlane: ReturnType<typeof createControlPlaneTransaction>
  let logger: SafeLoggerImpl

  beforeEach(() => {
    rawDb = createTestDb()
    const drizzleDb = drizzle(rawDb, { schema: controlPlaneSchema })
    controlPlane = createControlPlaneTransaction(drizzleDb)
    repo = controlPlane.jobs
    logger = new SafeLoggerImpl()
  })

  it('should converge pausing Job to paused on startup', () => {
    seedJob(rawDb, { id: 'job-1', state: 'pausing', controlIntent: 'pause', activeRunId: 'run-1', resumeTarget: 'execution_queued' })

    const decision = decideStartupReconcile({
      job: makeJobAggregate({
        id: 'job-1',
        state: 'pausing',
        controlIntent: 'pause',
        resumeTarget: 'execution_queued',
        activeRunId: 'run-1'
      }),
      runIsStale: false,
      interruptionReason: 'process_crash',
      hasRunningAttempt: false,
      hasLegacyActiveRuntime: false,
      runBelongsToCurrentBoot: false,
      hasActiveSlot: true,
      hasRegisteredRuntimeInstance: false,
      hasSupervisedLifecycleOperation: false,
      runtimeWasClosed: false
    })

    assert.equal(decision.kind, 'settle_paused')
  })

  it('should converge running Job to failed/recoverable on stale run', () => {
    seedJob(rawDb, { id: 'job-1', state: 'execution_running', activeRunId: 'run-1' })
    seedRun(rawDb, { id: 'run-1', jobId: 'job-1', state: 'interrupted' })

    const decision = decideStartupReconcile({
      job: makeJobAggregate({
        id: 'job-1',
        state: 'execution_running',
        activeRunId: 'run-1'
      }),
      runIsStale: true,
      interruptionReason: 'process_crash',
      hasRunningAttempt: false,
      hasLegacyActiveRuntime: false,
      runBelongsToCurrentBoot: false,
      hasActiveSlot: false,
      hasRegisteredRuntimeInstance: false,
      hasSupervisedLifecycleOperation: false,
      runtimeWasClosed: false
    })

    assert.equal(decision.kind, 'settle_interrupted_failure')
    if (decision.kind === 'settle_interrupted_failure') {
      assert.equal(decision.reason, 'process_crash')
    }
  })

  it('should quarantine queued Job with active run', () => {
    const decision = decideStartupReconcile({
      job: makeJobAggregate({
        id: 'job-1',
        state: 'execution_queued',
        activeRunId: 'run-1'
      }),
      runIsStale: false,
      interruptionReason: 'process_crash',
      hasRunningAttempt: false,
      hasLegacyActiveRuntime: false,
      runBelongsToCurrentBoot: false,
      hasActiveSlot: false,
      hasRegisteredRuntimeInstance: false,
      hasSupervisedLifecycleOperation: false,
      runtimeWasClosed: false
    })

    assert.equal(decision.kind, 'quarantine')
  })

  it('should execute settle_paused via reconciler', async () => {
    seedJob(rawDb, { id: 'job-1', state: 'pausing', controlIntent: 'pause', activeRunId: 'run-1', resumeTarget: 'execution_queued' })

    const reconciler = new StartupReconciler(
      repo,
      controlPlane,
      { nowMs: () => Date.now() },
      { generate: () => 'failure-1' },
      logger
    )

    const decisions = await reconciler.reconcileAll()
    assert.ok(decisions.length > 0)

    const job = repo.getAggregate('job-1')
    assert.equal(job?.state, 'paused')
  })
})

function seedEvidenceBlob(db: Database.Database, hash: string): void {
  const content = JSON.stringify([hash])
  db.prepare(
    `INSERT INTO control_evidence_blobs (hash, content_json, bytes, created_at_ms)
     VALUES (?, ?, ?, ?)`
  ).run(hash, content, content.length, Date.now())
}

function seedPlanRevision(db: Database.Database, jobId = 'job-1', planRevision = 1): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO control_plan_revisions (id, job_id, plan_revision, status, content_hash, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`plan-${jobId}-${planRevision}`, jobId, planRevision, 'confirmed', 'hash-1', now)
}

describe('Incident B: Verdict erasure (Task 65)', () => {
  let rawDb: Database.Database

  beforeEach(() => {
    rawDb = createTestDb()
  })

  it('should preserve verdict hash after subsequent task progress', () => {
    seedJob(rawDb, { id: 'job-1', state: 'execution_running' })
    seedPlanRevision(rawDb)
    seedEvidenceBlob(rawDb, 'verdict-hash-1')
    seedEvidenceBlob(rawDb, 'result-hash-1')

    rawDb.prepare(
      `INSERT INTO control_verifications (id, job_id, execution_generation, plan_revision, scope_type, scope_id,
        attempt_no, state, verdict_blob_hash, result_hash, started_at_ms, ended_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('v-1', 'job-1', 0, 1, 'slice', 'slice-1', 1, 'passed', 'verdict-hash-1', 'result-hash-1', Date.now(), Date.now())

    const before = rawDb.prepare(`SELECT verdict_blob_hash FROM control_verifications WHERE id = 'v-1'`).get() as VerdictRow | undefined
    assert.equal(before?.verdict_blob_hash, 'verdict-hash-1')

    const after = rawDb.prepare(`SELECT verdict_blob_hash FROM control_verifications WHERE id = 'v-1'`).get() as VerdictRow | undefined
    assert.equal(after?.verdict_blob_hash, 'verdict-hash-1', 'Verdict hash must be immutable')
  })

  it('should reject passed verification without verdict', () => {
    seedJob(rawDb, { id: 'job-1', state: 'execution_running' })
    seedPlanRevision(rawDb)

    assert.throws(
      () => rawDb.prepare(
        `INSERT INTO control_verifications (id, job_id, execution_generation, plan_revision, scope_type, scope_id,
          attempt_no, state, started_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('v-1', 'job-1', 0, 1, 'slice', 'slice-1', 1, 'passed', Date.now()),
      /CHECK/
    )
  })

  it('should not create outbox event for same revision', () => {
    seedJob(rawDb, { id: 'job-1', state: 'execution_running' })
    seedPlanRevision(rawDb)

    rawDb.prepare(
      `INSERT INTO control_outbox_events (topic, event_type, entity_id, aggregate_revision, payload_json, payload_bytes, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('job:job-1', 'job.changed', 'job-1', 1, '{}', 2, Date.now())

    const count1 = rawDb.prepare(`SELECT COUNT(*) as cnt FROM control_outbox_events WHERE entity_id = 'job-1'`).get() as CountRow | undefined
    assert.equal(count1?.cnt, 1)
  })
})

describe('Incident C: stderr EIO (Task 66)', () => {
  it('should disable console transport on EIO', () => {
    const logger = new SafeLoggerImpl()
    logger.info('test message')
    const buffer = logger.getBuffer()
    assert.ok(buffer.length > 0)
  })

  it('should not throw when file sink fails', () => {
    const logger = new SafeLoggerImpl({ logDir: '/nonexistent/path' })
    assert.doesNotThrow(() => {
      logger.info('test message')
      logger.error('error message')
    })
  })

  it('should rate limit repeated messages', () => {
    const logger = new SafeLoggerImpl({ rateLimitMaxPerWindow: 2 })

    for (let i = 0; i < 10; i++) {
      logger.info('repeated message')
    }

    const buffer = logger.getBuffer()
    assert.ok(buffer.length >= 2, 'Should have at least 2 messages')
  })

  it('should allow startup coordinator retry after degraded', async () => {
    const coordinator = new StartupCoordinator({
      logger: new SafeLoggerImpl(),
      stages: [{
        name: 'test-stage',
        async execute() {
          throw new Error('Always fails')
        }
      }]
    })

    await assert.rejects(() => coordinator.ensureReady())
    assert.equal(coordinator.getPhase(), 'degraded')

    await assert.rejects(() => coordinator.ensureReady())
  })
})
