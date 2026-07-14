import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { runMigrations } from '../../../src/server/db/migrations/runner'
import { allMigrations } from '../../../src/server/db/migrations/index'
import { controlPlaneSchema } from '../../../src/server/infra/sqlite/control-plane/schema'
import { SqliteJobRepository } from '../../../src/server/infra/sqlite/control-plane/job-repository'
import { createControlPlaneTransaction } from '../../../src/server/infra/sqlite/control-plane/sqlite-control-plane-unit-of-work'
import { JobCommandServiceImpl } from '../../../src/server/application/job-command-service'
import { StartupReconciler } from '../../../src/server/application/startup-reconciler-impl'
import { SafeLoggerImpl } from '../../../src/server/application/safe-logger'
import { availableActions } from '../../../src/server/domain/jobs/job-action-rules'
import { validateTaskResult } from '../../../src/server/domain/tasks/validate-task-result'
import { reduceJobSnapshot } from '../../../src/renderer/src/stores/entity-store'
import { EventReducer } from '../../../src/renderer/src/stores/event-reducer'
import type { RuntimeController } from '../../../src/server/application/ports/runtime-controller'
import { seedOwnedThreadJob } from '../fixtures/seed-owned-thread-job'

/**
 * PR0 scenarios 1–8 — cutover wrap-up C1.
 * Real temporary SQLite + Command / reconciler / store contracts.
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
    resumeTarget?: string | null
    executionGeneration?: number
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
      control_intent, resume_target, execution_generation, active_run_id, title, requirements_summary,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    jobId,
    `thread-${jobId}`,
    `project-${jobId}`,
    `draft-${jobId}`,
    opts.state ?? 'execution_queued',
    opts.stateRevision ?? 1,
    opts.controlIntent ?? 'none',
    opts.resumeTarget ?? null,
    opts.executionGeneration ?? 0,
    opts.activeRunId ?? null,
    'Test Job',
    'Test summary',
    now,
    now
  )
}

function seedRun(
  db: Database.Database,
  opts: {
    id?: string
    jobId?: string
    state?: string
    fenceToken?: string
    executionGeneration?: number
  } = {}
): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO control_job_runs (
      id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id ?? 'run-1',
    opts.jobId ?? 'job-1',
    'execution',
    opts.state ?? 'active',
    1,
    opts.fenceToken ?? 'fence-1',
    opts.executionGeneration ?? 0,
    now
  )
}

function seedTaskAndAttempt(
  db: Database.Database,
  opts: { attemptId?: string; taskId?: string; runId?: string; state?: string } = {}
): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO control_job_tasks (
      job_id, execution_generation, task_id, source_plan_revision, state, sort_order,
      title, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('job-1', 0, opts.taskId ?? 'task-1', 1, 'running', 0, 'Task 1', now, now)

  db.prepare(
    `INSERT INTO control_task_attempts (
      id, job_id, execution_generation, task_id, attempt_no, run_id, state, started_at_ms, result_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.attemptId ?? 'attempt-1',
    'job-1',
    0,
    opts.taskId ?? 'task-1',
    1,
    opts.runId ?? 'run-1',
    opts.state ?? 'running',
    now,
    0
  )
}

function createCommandService(rawDb: Database.Database): {
  service: JobCommandServiceImpl
  jobRepository: SqliteJobRepository
  controlPlane: ReturnType<typeof createControlPlaneTransaction>
} {
  const drizzleDb = drizzle(rawDb, { schema: controlPlaneSchema })
  const controlPlane = createControlPlaneTransaction(drizzleDb)
  const jobRepository = controlPlane.jobs
  const runtimeController: RuntimeController = {
    notifyPauseRequested() {},
    async closeThenRelease() {}
  }
  const service = new JobCommandServiceImpl({
    unitOfWork: controlPlane,
    clock: { nowMs: () => 1_700_000_000_000 },
    idGenerator: { generate: () => randomUUID() },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    runtimeController
  })
  return { service, jobRepository, controlPlane }
}

describe('PR0 Required Scenarios 1-8 (C1)', () => {
  let rawDb: Database.Database

  beforeEach(() => {
    rawDb = createTestDb()
  })

  describe('Scenario 1: planning_running pause then crash', () => {
    it('should settle to paused on restart', async () => {
      seedJob(rawDb, {
        state: 'planning_running',
        stateRevision: 1,
        activeRunId: 'run-1'
      })
      seedRun(rawDb, { state: 'active' })
      rawDb.prepare(`UPDATE control_job_runs SET kind = 'planning' WHERE id = 'run-1'`).run()

      const { service, jobRepository, controlPlane } = createCommandService(rawDb)
      const paused = await service.requestPause({
        actor: { username: 'u1', requestId: 'r1' },
        jobId: 'job-1',
        expectedRevision: 1,
        idempotencyKey: randomUUID()
      })
      assert.equal(paused.job.state, 'pausing')

      const reconciler = new StartupReconciler(
        jobRepository,
        controlPlane,
        { nowMs: () => Date.now() },
        { generate: () => 'failure-1' },
        new SafeLoggerImpl()
      )
      await reconciler.reconcileAll()

      const job = jobRepository.getAggregate('job-1')
      assert.equal(job?.state, 'paused')
      assert.equal(job?.controlIntent, 'none')
    })
  })

  describe('Scenario 2: execution_running no intent crash', () => {
    it('should settle to recoverable failed on restart', async () => {
      seedJob(rawDb, {
        state: 'execution_running',
        stateRevision: 1,
        activeRunId: 'run-1',
        controlIntent: 'none'
      })
      seedRun(rawDb, { state: 'interrupted' })

      const { jobRepository, controlPlane } = createCommandService(rawDb)
      const reconciler = new StartupReconciler(
        jobRepository,
        controlPlane,
        { nowMs: () => Date.now() },
        { generate: () => 'failure-1' },
        new SafeLoggerImpl()
      )
      await reconciler.reconcileAll()

      const job = jobRepository.getAggregate('job-1')
      assert.equal(job?.state, 'failed')
      assert.ok(job?.lastFailureId)
    })
  })

  describe('Scenario 3: Cancel commit then old worker checkpoint', () => {
    it('should reject checkpoint from cancelled job', async () => {
      seedJob(rawDb, {
        state: 'execution_running',
        stateRevision: 1,
        activeRunId: 'run-1'
      })
      seedRun(rawDb)
      seedTaskAndAttempt(rawDb)
      const { service, jobRepository } = createCommandService(rawDb)

      await service.cancelJob({
        actor: { username: 'u1', requestId: 'r1' },
        jobId: 'job-1',
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        payload: { reasonCode: 'user_cancelled' }
      })

      const fence = jobRepository.workerFence({
        jobId: 'job-1',
        expectedRevision: 2,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        updatedAtMs: Date.now()
      })
      assert.equal(fence.ok, false)

      await assert.rejects(
        () =>
          service.checkpointTask({
            jobId: 'job-1',
            expectedRevision: 2,
            runId: 'run-1',
            fenceToken: 'fence-1',
            executionGeneration: 0,
            payload: {
              attemptId: 'attempt-1',
              result: {
                status: 'completed',
                summary: 'late',
                changedFiles: [],
                evidence: ['x'],
                validation: { ran: true, outcome: 'passed' },
                blockers: [],
                blockerKind: null
              }
            }
          }),
        (err: unknown) => err instanceof Error
      )
    })
  })

  describe('Scenario 4: pausing with last task success', () => {
    it('should still go to paused first', async () => {
      seedJob(rawDb, {
        state: 'pausing',
        stateRevision: 2,
        controlIntent: 'pause',
        activeRunId: 'run-1',
        resumeTarget: 'execution_queued'
      })
      seedRun(rawDb, { state: 'pausing' })
      seedTaskAndAttempt(rawDb)
      const { service, jobRepository } = createCommandService(rawDb)

      const checkpoint = await service.checkpointTask({
        jobId: 'job-1',
        expectedRevision: 2,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: {
          attemptId: 'attempt-1',
          result: {
            status: 'completed',
            summary: 'last task',
            changedFiles: [],
            evidence: ['ok'],
            validation: { ran: true, outcome: 'passed' },
            blockers: [],
            blockerKind: null
          }
        }
      })
      assert.equal(checkpoint.mustPause, true)

      let job = jobRepository.getOwnedAggregate({
        actor: { username: 'u1', requestId: '' },
        jobId: 'job-1'
      })
      assert.equal(job?.state, 'pausing')

      await service.acknowledgePause({
        jobId: 'job-1',
        expectedRevision: checkpoint.revision,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: {}
      })

      job = jobRepository.getOwnedAggregate({
        actor: { username: 'u1', requestId: '' },
        jobId: 'job-1'
      })
      assert.equal(job?.state, 'paused')
      assert.notEqual(job?.state, 'succeeded')
    })
  })

  describe('Scenario 5: REST revision 10 then SSE revision 9', () => {
    it('must not overwrite with older revision', () => {
      const rest = reduceJobSnapshot(
        undefined,
        { id: 'job-1', stateRevision: 10 },
        'authoritative_snapshot'
      )
      assert.equal(rest.kind, 'accept')
      if (rest.kind !== 'accept') return

      const sse = reduceJobSnapshot(
        rest.next,
        { id: 'job-1', stateRevision: 9 },
        'incremental_event'
      )
      assert.equal(sse.kind, 'ignore_stale')
      assert.equal(rest.next.revision, 10)
    })
  })

  describe('Scenario 6: SSE jump from revision 10 to 12', () => {
    it('must pull snapshot on gap detection', () => {
      const current = reduceJobSnapshot(
        undefined,
        { id: 'job-1', stateRevision: 10 },
        'authoritative_snapshot'
      )
      assert.equal(current.kind, 'accept')
      if (current.kind !== 'accept') return

      const gap = reduceJobSnapshot(
        current.next,
        { id: 'job-1', stateRevision: 12 },
        'incremental_event'
      )
      assert.equal(gap.kind, 'resync')
    })
  })

  describe('Scenario 7: completed task + validation failed', () => {
    it('should reject invalid task result', () => {
      assert.throws(
        () =>
          validateTaskResult({
            status: 'completed',
            summary: 'done',
            changedFiles: [],
            evidence: ['x'],
            validation: { ran: true, outcome: 'failed' },
            blockers: [],
            blockerKind: null
          }),
        (err: unknown) =>
          err instanceof Error &&
          (/completed_validation_not_passed|must have passed/.test(err.message) ||
            ('code' in err &&
              (err as { code: string }).code === 'task_result.completed_validation_not_passed'))
      )
    })
  })

  describe('Scenario 8: active Job Delete and pausing Cancel', () => {
    it('should reject delete on active job', () => {
      const actions = availableActions({
        state: 'execution_running',
        recoverability: null,
        hasConfirmedPlan: true
      })
      assert.ok(!actions.includes('delete'))
      assert.ok(actions.includes('cancel'))
    })

    it('should reject cancel on pausing job', () => {
      const actions = availableActions({
        state: 'pausing',
        recoverability: null,
        hasConfirmedPlan: true
      })
      assert.deepEqual(actions, [])
    })
  })
})
