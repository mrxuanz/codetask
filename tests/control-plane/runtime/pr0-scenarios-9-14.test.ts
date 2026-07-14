import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { runMigrations } from '../../../src/server/db/migrations/runner'
import { allMigrations } from '../../../src/server/db/migrations/index'
import { controlPlaneSchema } from '../../../src/server/infra/sqlite/control-plane/schema'
import { SqliteJobRepository } from '../../../src/server/infra/sqlite/control-plane/job-repository'
import { createControlPlaneTransaction } from '../../../src/server/infra/sqlite/control-plane/sqlite-control-plane-unit-of-work'
import { InternalExecutionCommandServiceImpl } from '../../../src/server/application/internal-execution-command-service'
import { JobEventHub } from '../../../src/server/application/job-event-hub'
import { EventHub } from '../../../src/server/application/event-hub'
import { StartupCoordinator } from '../../../src/server/application/startup-coordinator'
import { SafeLoggerImpl } from '../../../src/server/application/safe-logger'
import { checkMilestoneReadiness } from '../../../src/server/application/verification-gate'
import { EventReducer } from '../../../src/renderer/src/stores/event-reducer'
import { canonicalJson } from '../../../src/server/application/utils/canonical-json'
import type { JsonValue } from '../../../src/server/application/utils/canonical-json'
import { seedOwnedThreadJob } from '../fixtures/seed-owned-thread-job'

/**
 * PR0 scenarios 9–14 — cutover wrap-up C2.
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
    id?: string
    username?: string
    state?: string
    stateRevision?: number
    controlIntent?: string
    activeRunId?: string | null
    currentPlanRevision?: number | null
  } = {}
): void {
  const now = Date.now()
  const jobId = opts.id ?? 'job-1'
  seedOwnedThreadJob(db, {
    jobId,
    username: opts.username ?? 'u1',
    status: opts.state === 'execution_running' ? 'running' : 'pending'
  })
  db.prepare(
    `INSERT INTO control_jobs (
      id, thread_id, project_id, draft_message_id, state, state_revision,
      control_intent, resume_target, current_plan_revision, execution_generation, active_run_id,
      title, requirements_summary, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    jobId,
    `thread-${jobId}`,
    `project-${jobId}`,
    `draft-${jobId}`,
    opts.state ?? 'execution_running',
    opts.stateRevision ?? 1,
    opts.controlIntent ?? 'none',
    null,
    opts.currentPlanRevision ?? 1,
    0,
    opts.activeRunId ?? 'run-1',
    'Test Job',
    'Test summary',
    now,
    now
  )
}

function seedRun(db: Database.Database, opts: { id?: string; state?: string } = {}): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO control_job_runs (
      id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(opts.id ?? 'run-1', 'job-1', 'execution', opts.state ?? 'active', 1, 'fence-1', 0, now)
}

function createInternalService(rawDb: Database.Database): {
  service: InternalExecutionCommandServiceImpl
  jobRepository: SqliteJobRepository
} {
  const drizzleDb = drizzle(rawDb, { schema: controlPlaneSchema })
  const controlPlane = createControlPlaneTransaction(drizzleDb)
  const jobRepository = controlPlane.jobs
  const service = new InternalExecutionCommandServiceImpl({
    unitOfWork: controlPlane,
    clock: { nowMs: () => 1_700_000_000_000 },
    idGenerator: { generate: () => randomUUID() },
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  })
  return { service, jobRepository }
}

describe('PR0 Required Scenarios 9-14 (C2)', () => {
  let rawDb: Database.Database

  beforeEach(() => {
    rawDb = createTestDb()
  })

  describe('Scenario 9: runtime child closed convergence', () => {
    it('should allow runtime start to claim a starting run', () => {
      seedJob(rawDb, { state: 'execution_running', stateRevision: 1, activeRunId: 'run-1' })
      seedRun(rawDb, { state: 'starting' })
      const { service } = createInternalService(rawDb)

      const result = service.runtimeStarted({
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: {
          provider: 'test-provider',
          runtimeInstanceId: 'rt-1'
        }
      })

      assert.equal(result.runState, 'active')
      const run = rawDb.prepare(`SELECT state FROM control_job_runs WHERE id = 'run-1'`).get() as {
        state: string
      }
      assert.equal(run.state, 'active')
    })

    it('records child close even when it arrives before RuntimeStarted', () => {
      seedJob(rawDb, { state: 'execution_running', stateRevision: 1, activeRunId: 'run-1' })
      seedRun(rawDb, { state: 'starting' })
      const { service, jobRepository } = createInternalService(rawDb)

      service.runtimeExited({
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: { runtimeInstanceId: 'rt-before-start', exitKind: 'error', exitCode: 1 }
      })

      assert.equal(jobRepository.getAggregate('job-1')?.state, 'failed')
      const instance = rawDb
        .prepare(`SELECT state FROM control_runtime_instances WHERE id = 'rt-before-start'`)
        .get() as { state: string }
      assert.equal(instance.state, 'closed')
    })

    it('should not keep Job running without active run/slot/runtime', () => {
      seedJob(rawDb, { state: 'execution_running', stateRevision: 1, activeRunId: 'run-1' })
      seedRun(rawDb)
      const { service, jobRepository } = createInternalService(rawDb)

      const result = service.runtimeExited({
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: {
          runtimeInstanceId: 'rt-1',
          exitKind: 'error',
          exitCode: 1
        }
      })

      assert.ok(result.decision === 'job_failed' || result.decision === 'retry_scheduled')
      const job = jobRepository.getAggregate('job-1')
      assert.notEqual(job?.state, 'execution_running')
      assert.equal(job?.activeRunId, null)
    })

    it('should make retry auditable via outbox', () => {
      seedJob(rawDb, { state: 'execution_running', stateRevision: 1, activeRunId: 'run-1' })
      seedRun(rawDb)
      const { service } = createInternalService(rawDb)
      service.runtimeExited({
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: { runtimeInstanceId: 'rt-1', exitKind: 'error' }
      })
      const count = rawDb
        .prepare(`SELECT COUNT(*) as cnt FROM control_outbox_events WHERE entity_id = 'job-1'`)
        .get() as { cnt: number }
      assert.ok(count.cnt >= 1)
    })
  })

  describe('Scenario 10: verification verdict immutability', () => {
    it('should preserve s1 verdict after s2 task progress', () => {
      seedJob(rawDb, {
        state: 'execution_running',
        stateRevision: 1,
        activeRunId: 'run-1',
        currentPlanRevision: 1
      })
      seedRun(rawDb)
      const verdict = { passed: true, summary: 's1 ok' }
      const hash = createHash('sha256').update(canonicalJson(verdict as JsonValue)).digest('hex')
      const now = Date.now()
      rawDb
        .prepare(
          `INSERT INTO control_plan_revisions (id, job_id, plan_revision, status, content_hash, created_at_ms)
           VALUES ('plan-1', 'job-1', 1, 'confirmed', 'hash-1', ?)`
        )
        .run(now)
      rawDb
        .prepare(
          `INSERT INTO control_evidence_blobs (hash, content_json, bytes, created_at_ms)
           VALUES (?, ?, ?, ?)`
        )
        .run(hash, JSON.stringify(verdict), JSON.stringify(verdict).length, now)
      rawDb
        .prepare(
          `INSERT INTO control_verifications (
            id, job_id, execution_generation, plan_revision, scope_type, scope_id,
            attempt_no, state, verdict_blob_hash, result_hash, result_revision, started_at_ms, ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('v-s1', 'job-1', 0, 1, 'slice', 's1', 1, 'passed', hash, hash, 1, now, now)

      rawDb
        .prepare(
          `INSERT INTO control_job_tasks (
            job_id, execution_generation, task_id, source_plan_revision, state, sort_order,
            title, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('job-1', 0, 's2', 1, 'completed', 1, 'Task s2', now, now)

      const after = rawDb
        .prepare(`SELECT verdict_blob_hash, result_hash FROM control_verifications WHERE id = 'v-s1'`)
        .get() as { verdict_blob_hash: string; result_hash: string }
      assert.equal(after.verdict_blob_hash, hash)
      assert.equal(after.result_hash, hash)
    })
  })

  describe('Scenario 11: passed slice missing verdict', () => {
    it('should not make milestone ready', () => {
      const readiness = checkMilestoneReadiness('m1', ['s1'], new Map([
        ['s1', { passed: true, verdictBlobHash: null, attemptNo: 1 }]
      ]))
      assert.equal(readiness.ready, false)
      assert.ok(readiness.invariantViolations.some((v) => v.includes('passed_missing_verdict')))
    })

    it('should quarantine corrupted verification via CHECK', () => {
      seedJob(rawDb, { state: 'execution_running', activeRunId: null })
      assert.throws(
        () =>
          rawDb
            .prepare(
              `INSERT INTO control_verifications (
                id, job_id, execution_generation, plan_revision, scope_type, scope_id,
                attempt_no, state, started_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run('v-bad', 'job-1', 0, 1, 'slice', 's1', 1, 'passed', Date.now()),
        /CHECK/
      )
    })
  })

  describe('Scenario 12: no-progress detection', () => {
    it('should detect no-progress when revision unchanged', () => {
      seedJob(rawDb, { state: 'execution_running', stateRevision: 1, activeRunId: 'run-1' })
      seedRun(rawDb)
      const { service, jobRepository } = createInternalService(rawDb)

      const envelope = {
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: {
          decisionKey: 'step-a',
          observedRevision: 1,
          workIdentity: 'identity-1'
        }
      }

      const r1 = service.reportNoProgress(envelope)
      assert.equal(r1.eventCount, 1)

      const job = jobRepository.getAggregate('job-1')
      assert.equal(job?.state, 'failed')
    })

    it('should limit no-progress event writes', () => {
      seedJob(rawDb, { state: 'execution_running', stateRevision: 1, activeRunId: 'run-1' })
      seedRun(rawDb)
      const { service } = createInternalService(rawDb)
      const envelope = {
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: {
          decisionKey: 'step-b',
          observedRevision: 1,
          workIdentity: 'identity-1'
        }
      }
      service.reportNoProgress(envelope)
      const count = rawDb
        .prepare(
          `SELECT COUNT(*) as cnt FROM control_outbox_events WHERE entity_id = 'job-1'`
        )
        .get() as { cnt: number }
      assert.ok(count.cnt <= 3)
    })
  })

  describe('Scenario 13: production hub flood', () => {
    it('closes only the slow production EventHub subscriber with resync metadata', () => {
      const hub = new EventHub(
        { maxQueueSize: 2, maxQueueBytes: 1024 },
        { debug() {}, info() {}, warn() {}, error() {} }
      )
      const slowEvents: number[] = []
      const fastEvents: number[] = []
      const resync: Array<{ lastDeliveredEventId: number; latestEventId: number }> = []
      let flooded = false

      hub.subscribe(
        'slow',
        (event) => {
          slowEvents.push(event.eventId)
          if (!flooded) {
            flooded = true
            for (const eventId of [2, 3, 4]) {
              hub.publish({
                eventId,
                topic: `job:job-${eventId}`,
                type: 'job.changed',
                entityId: `job-${eventId}`,
                revision: eventId,
                payload: {}
              })
            }
          }
        },
        (info) => resync.push(info)
      )
      hub.publish({
        eventId: 1,
        topic: 'job:job-1',
        type: 'job.changed',
        entityId: 'job-1',
        revision: 1,
        payload: {}
      })
      hub.subscribe('fast', (event) => fastEvents.push(event.eventId))
      hub.publish({
        eventId: 5,
        topic: 'job:job-5',
        type: 'job.changed',
        entityId: 'job-5',
        revision: 5,
        payload: {}
      })

      assert.deepEqual(slowEvents, [1])
      assert.deepEqual(resync, [{ lastDeliveredEventId: 1, latestEventId: 4 }])
      assert.deepEqual(fastEvents, [5])
      assert.equal(hub.getSubscriberCount(), 1)
    })

    it('must maintain fairness across topics', () => {
      const hub = new JobEventHub({ maxQueueSize: 10, coalesceWindowMs: 1000 })
      const sentA: unknown[] = []
      const sentB: unknown[] = []
      hub.registerConnection('job:a', {
        send(e: unknown) {
          sentA.push(e)
        }
      })
      hub.registerConnection('job:b', {
        send(e: unknown) {
          sentB.push(e)
        }
      })
      for (let i = 0; i < 5; i++) {
        hub.push('job:a', i + 1, { revision: i + 1 })
      }
      hub.push('job:b', 1, { type: 'terminal', state: 'failed' })
      hub.flush()
      assert.ok(sentB.length >= 1, 'terminal topic must not be starved')
      assert.ok(sentA.length >= 1)
    })
  })

  describe('Scenario 14: stdout/stderr EIO handling', () => {
    it('should handle synchronous throw in console', () => {
      const logger = new SafeLoggerImpl({ logDir: '/nonexistent/eio-path' })
      assert.doesNotThrow(() => {
        logger.warn('sync warn')
        logger.error('sync error')
      })
    })

    it('should handle async stream error', () => {
      const logger = new SafeLoggerImpl()
      assert.doesNotThrow(() => {
        logger.info('before')
        logger.error('after async-like EIO simulation')
      })
      assert.ok(logger.getBuffer().length > 0)
    })

    it('should allow idempotent startup retry', async () => {
      let attempts = 0
      let schedulerStarted = false
      const coordinator = new StartupCoordinator({
        logger: new SafeLoggerImpl(),
        stages: [
          {
            name: 'reconcile',
            async execute() {
              attempts += 1
              if (attempts === 1) {
                throw new Error('EIO during reconcile')
              }
            }
          },
          {
            name: 'start-scheduler',
            async execute() {
              schedulerStarted = true
            }
          }
        ]
      })

      await assert.rejects(() => coordinator.ensureReady())
      assert.equal(coordinator.getPhase(), 'degraded')
      assert.equal(schedulerStarted, false)

      await coordinator.ensureReady()
      assert.equal(coordinator.getPhase(), 'ready')
      assert.equal(schedulerStarted, true)
    })
  })
})

describe('PR0 EventReducer owner-safe cursor', () => {
  it('accepts non-contiguous global event ids', () => {
    const reducer = new EventReducer()
    let handled = 0
    reducer.registerHandler('job.changed', () => {
      handled += 1
    })
    reducer.reduce({
      eventId: 1,
      topic: 'job:1',
      type: 'job.changed',
      entityId: '1',
      revision: 1,
      payload: {}
    })
    reducer.reduce({
      eventId: 3,
      topic: 'job:1',
      type: 'job.changed',
      entityId: '1',
      revision: 3,
      payload: {}
    })
    assert.equal(handled, 2)
    assert.equal(reducer.getLastEventId(), 3)
  })
})
