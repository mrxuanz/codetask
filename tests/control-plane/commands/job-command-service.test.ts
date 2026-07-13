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
import {
  canonicalJson,
  hashCanonicalCommand
} from '../../../src/server/application/utils/canonical-json'
import type { RuntimeController } from '../../../src/server/application/ports/runtime-controller'
import { seedOwnedThreadJob } from '../fixtures/seed-owned-thread-job'

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

describe('canonicalJson / hashCanonicalCommand', () => {
  it('sorts object keys for stable hash', () => {
    const a = canonicalJson({ b: 1, a: 2 })
    const b = canonicalJson({ a: 2, b: 1 })
    assert.equal(a, b)
    assert.equal(hashCanonicalCommand('cancel_job', { reasonCode: 'x' }), hashCanonicalCommand('cancel_job', { reasonCode: 'x' }))
    assert.notEqual(
      hashCanonicalCommand('request_pause', null),
      hashCanonicalCommand('continue_job', null)
    )
  })
})

describe('JobCommandService', () => {
  let rawDb: Database.Database
  let service: JobCommandServiceImpl
  let runtimeStops: string[]
  let pauseNotifications: string[]

  beforeEach(() => {
    rawDb = createTestDb()
    const drizzleDb = drizzle(rawDb, { schema: controlPlaneSchema })
    const jobRepository = new SqliteJobRepository(drizzleDb)
    const taskRepository = new SqliteTaskRepository(drizzleDb)
    const evidenceRepository = new EvidenceRepository(drizzleDb)
    runtimeStops = []
    pauseNotifications = []
    const runtimeController: RuntimeController = {
      notifyPauseRequested(jobId) {
        pauseNotifications.push(jobId)
      },
      async closeThenRelease(runId) {
        runtimeStops.push(runId)
      }
    }
    service = new JobCommandServiceImpl({
      jobRepository,
      taskRepository,
      evidenceRepository,
      clock: { nowMs: () => 1_700_000_000_000 },
      idGenerator: { generate: () => randomUUID() },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {}
      },
      runtimeController
    })
  })

  describe('requestPause', () => {
    it('should succeed for queued job', async () => {
      seedJob(rawDb, { state: 'execution_queued', stateRevision: 1 })
      const result = await service.requestPause({
        actor: { username: 'u1', requestId: 'r1' },
        jobId: 'job-1',
        expectedRevision: 1,
        idempotencyKey: randomUUID()
      })
      assert.equal(result.job.state, 'paused')
      assert.equal(result.job.stateRevision, 2)
      assert.deepEqual(pauseNotifications, ['job-1'])
    })

    it('should replay same request with same idempotency key', async () => {
      seedJob(rawDb, { state: 'execution_queued', stateRevision: 1 })
      const key = randomUUID()
      const first = await service.requestPause({
        actor: { username: 'u1', requestId: 'r1' },
        jobId: 'job-1',
        expectedRevision: 1,
        idempotencyKey: key
      })
      const second = await service.requestPause({
        actor: { username: 'u1', requestId: 'r2' },
        jobId: 'job-1',
        expectedRevision: 1,
        idempotencyKey: key
      })
      assert.deepEqual(second, first)
    })

    it('should reject same key with different payload', async () => {
      seedJob(rawDb, { state: 'execution_queued', stateRevision: 1 })
      const key = randomUUID()
      await service.requestPause({
        actor: { username: 'u1', requestId: 'r1' },
        jobId: 'job-1',
        expectedRevision: 1,
        idempotencyKey: key
      })
      await assert.rejects(
        () =>
          service.continueJob({
            actor: { username: 'u1', requestId: 'r2' },
            jobId: 'job-1',
            expectedRevision: 2,
            idempotencyKey: key
          }),
        /idempotency_key_reused/
      )
    })

    it('should reject stale revision', async () => {
      seedJob(rawDb, { state: 'execution_queued', stateRevision: 1 })
      await assert.rejects(
        () =>
          service.requestPause({
            actor: { username: 'u1', requestId: 'r1' },
            jobId: 'job-1',
            expectedRevision: 99,
            idempotencyKey: randomUUID()
          }),
        /job.revision_conflict/
      )
    })

    it('should reject commands for another users job', async () => {
      seedJob(rawDb, { state: 'execution_queued', stateRevision: 1, username: 'owner-1' })
      await assert.rejects(
        () =>
          service.requestPause({
            actor: { username: 'owner-2', requestId: 'r1' },
            jobId: 'job-1',
            expectedRevision: 1,
            idempotencyKey: randomUUID()
          }),
        /job.not_found/
      )
    })

    it('should reject invalid state transition', async () => {
      seedJob(rawDb, { state: 'paused', stateRevision: 1, resumeTarget: 'execution_queued' })
      await assert.rejects(
        () =>
          service.requestPause({
            actor: { username: 'u1', requestId: 'r1' },
            jobId: 'job-1',
            expectedRevision: 1,
            idempotencyKey: randomUUID()
          }),
        (err: unknown) =>
          err instanceof Error && /not allowed|action_not_allowed/.test(err.message)
      )
    })
  })

  describe('cancelJob', () => {
    it('should commit cancelled before stopping runtime', async () => {
      seedJob(rawDb, {
        state: 'execution_running',
        stateRevision: 1,
        activeRunId: 'run-1'
      })
      seedRun(rawDb)
      const result = await service.cancelJob({
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

    it('should invalidate fence on cancel', async () => {
      seedJob(rawDb, {
        state: 'execution_running',
        stateRevision: 1,
        activeRunId: 'run-1'
      })
      seedRun(rawDb)
      await service.cancelJob({
        actor: { username: 'u1', requestId: 'r1' },
        jobId: 'job-1',
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        payload: { reasonCode: 'user_cancelled' }
      })
      const jobRepository = new SqliteJobRepository(drizzle(rawDb, { schema: controlPlaneSchema }))
      const fence = jobRepository.workerFence({
        jobId: 'job-1',
        expectedRevision: 2,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        updatedAtMs: Date.now()
      })
      assert.equal(fence.ok, false)
    })
  })

  describe('acknowledgePause', () => {
    it('should transition from pausing to paused', async () => {
      seedJob(rawDb, {
        state: 'pausing',
        stateRevision: 2,
        controlIntent: 'pause',
        activeRunId: 'run-1',
        resumeTarget: 'execution_queued'
      })
      seedRun(rawDb, { state: 'pausing' })
      await service.acknowledgePause({
        jobId: 'job-1',
        expectedRevision: 2,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: {}
      })
      const job = rawDb.prepare(`SELECT state, active_run_id, resume_target FROM control_jobs WHERE id = 'job-1'`).get() as {
        state: string
        active_run_id: string | null
        resume_target: string
      }
      assert.equal(job.state, 'paused')
      assert.equal(job.active_run_id, null)
      assert.equal(job.resume_target, 'execution_queued')
      assert.deepEqual(runtimeStops, ['run-1'])
    })

    it('should reject if not in pausing state', async () => {
      seedJob(rawDb, {
        state: 'execution_running',
        stateRevision: 1,
        activeRunId: 'run-1'
      })
      seedRun(rawDb)
      await assert.rejects(
        () =>
          service.acknowledgePause({
            jobId: 'job-1',
            expectedRevision: 1,
            runId: 'run-1',
            fenceToken: 'fence-1',
            executionGeneration: 0,
            payload: {}
          }),
        /pause_ack_not_allowed/
      )
    })
  })

  describe('checkpointTask', () => {
    const completedResult = {
      status: 'completed' as const,
      summary: 'done',
      changedFiles: ['a.ts'],
      evidence: ['looks good'],
      validation: { ran: true, outcome: 'passed' as const },
      blockers: [],
      blockerKind: null
    }

    it('should complete task atomically', async () => {
      seedJob(rawDb, {
        state: 'execution_running',
        stateRevision: 1,
        activeRunId: 'run-1'
      })
      seedRun(rawDb)
      seedTaskAndAttempt(rawDb)
      const result = await service.checkpointTask({
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: { attemptId: 'attempt-1', result: completedResult }
      })
      assert.equal(result.revision, 2)
      assert.equal(result.mustPause, false)
      const task = rawDb
        .prepare(`SELECT state FROM control_job_tasks WHERE task_id = 'task-1'`)
        .get() as { state: string }
      assert.equal(task.state, 'completed')
    })

    it('should replay a matching checkpoint with its stored revision', async () => {
      seedJob(rawDb, {
        state: 'execution_running',
        stateRevision: 1,
        activeRunId: 'run-1'
      })
      seedRun(rawDb)
      seedTaskAndAttempt(rawDb)
      const input = {
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: { attemptId: 'attempt-1', result: completedResult }
      }

      const first = await service.checkpointTask(input)
      const replay = await service.checkpointTask(input)

      assert.equal(first.revision, 2)
      assert.equal(replay.revision, 2)
      const attempt = rawDb
        .prepare(`SELECT result_hash, evidence_blob_hash, result_revision FROM control_task_attempts WHERE id = 'attempt-1'`)
        .get() as { result_hash: string; evidence_blob_hash: string; result_revision: number }
      assert.ok(attempt.result_hash)
      assert.ok(attempt.evidence_blob_hash)
      assert.equal(attempt.result_revision, 2)
    })

    it('should return mustPause when job is pausing', async () => {
      seedJob(rawDb, {
        state: 'pausing',
        stateRevision: 2,
        controlIntent: 'pause',
        activeRunId: 'run-1',
        resumeTarget: 'execution_queued'
      })
      seedRun(rawDb, { state: 'pausing' })
      seedTaskAndAttempt(rawDb)
      const result = await service.checkpointTask({
        jobId: 'job-1',
        expectedRevision: 2,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: { attemptId: 'attempt-1', result: completedResult }
      })
      assert.equal(result.mustPause, true)
      const job = rawDb.prepare(`SELECT state FROM control_jobs WHERE id = 'job-1'`).get() as {
        state: string
      }
      assert.equal(job.state, 'pausing')
    })

    it('should not change verification', async () => {
      seedJob(rawDb, {
        state: 'execution_running',
        stateRevision: 1,
        activeRunId: 'run-1'
      })
      seedRun(rawDb)
      seedTaskAndAttempt(rawDb)
      rawDb
        .prepare(
          `INSERT INTO control_verifications (
            id, job_id, execution_generation, plan_revision, scope_type, scope_id,
            attempt_no, state, verdict_blob_hash, result_hash, started_at_ms, ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'v-1',
          'job-1',
          0,
          1,
          'slice',
          'slice-1',
          1,
          'passed',
          'vh',
          'rh',
          Date.now(),
          Date.now()
        )
      await service.checkpointTask({
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        payload: { attemptId: 'attempt-1', result: completedResult }
      })
      const v = rawDb
        .prepare(`SELECT verdict_blob_hash FROM control_verifications WHERE id = 'v-1'`)
        .get() as { verdict_blob_hash: string }
      assert.equal(v.verdict_blob_hash, 'vh')
    })
  })

  describe('continue versus restart projections', () => {
    it('continues in the same generation without changing passed verifications', async () => {
      seedJob(rawDb, {
        state: 'paused',
        stateRevision: 2,
        resumeTarget: 'execution_queued',
        executionGeneration: 3
      })
      rawDb
        .prepare(
          `INSERT INTO control_verifications (
            id, job_id, execution_generation, plan_revision, scope_type, scope_id,
            attempt_no, state, verdict_blob_hash, result_hash, started_at_ms, ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'passed-slice',
          'job-1',
          3,
          1,
          'slice',
          'slice-1',
          1,
          'passed',
          'verdict-hash',
          'result-hash',
          Date.now(),
          Date.now()
        )

      const result = await service.continueJob({
        actor: { username: 'u1', requestId: 'r1' },
        jobId: 'job-1',
        expectedRevision: 2,
        idempotencyKey: randomUUID()
      })

      assert.equal(result.job.state, 'execution_queued')
      const job = rawDb
        .prepare(`SELECT execution_generation FROM control_jobs WHERE id = 'job-1'`)
        .get() as { execution_generation: number }
      assert.equal(job.execution_generation, 3)
      const verificationCount = rawDb
        .prepare(
          `SELECT COUNT(*) AS count FROM control_verifications
           WHERE job_id = 'job-1' AND execution_generation = 3 AND state = 'passed'`
        )
        .get() as { count: number }
      assert.equal(verificationCount.count, 1)
    })

    it('restarts into a fresh task generation while retaining old history', async () => {
      seedJob(rawDb, {
        state: 'failed',
        stateRevision: 4,
        executionGeneration: 0
      })
      seedRun(rawDb)
      seedTaskAndAttempt(rawDb)

      const result = await service.restartExecution({
        actor: { username: 'u1', requestId: 'r1' },
        jobId: 'job-1',
        expectedRevision: 4,
        idempotencyKey: randomUUID(),
        payload: {}
      })

      assert.equal(result.job.state, 'execution_queued')
      const job = rawDb
        .prepare(`SELECT execution_generation FROM control_jobs WHERE id = 'job-1'`)
        .get() as { execution_generation: number }
      assert.equal(job.execution_generation, 1)
      const tasks = rawDb
        .prepare(
          `SELECT execution_generation, state FROM control_job_tasks
           WHERE job_id = 'job-1' ORDER BY execution_generation`
        )
        .all() as Array<{ execution_generation: number; state: string }>
      assert.deepEqual(tasks, [
        { execution_generation: 0, state: 'running' },
        { execution_generation: 1, state: 'queued' }
      ])
      const attempts = rawDb
        .prepare(
          `SELECT COUNT(*) AS count FROM control_task_attempts
           WHERE job_id = 'job-1' AND execution_generation = 1`
        )
        .get() as { count: number }
      assert.equal(attempts.count, 0)
    })
  })

  describe('idempotency', () => {
    it('should return same response for same hash replay', async () => {
      seedJob(rawDb, { state: 'execution_queued', stateRevision: 1 })
      const key = randomUUID()
      const a = await service.requestPause({
        actor: { username: 'u1', requestId: 'r1' },
        jobId: 'job-1',
        expectedRevision: 1,
        idempotencyKey: key
      })
      const b = await service.requestPause({
        actor: { username: 'u1', requestId: 'r2' },
        jobId: 'job-1',
        expectedRevision: 1,
        idempotencyKey: key
      })
      assert.deepEqual(a, b)
    })

    it('should reject different hash with same key', async () => {
      seedJob(rawDb, {
        state: 'paused',
        stateRevision: 2,
        resumeTarget: 'execution_queued'
      })
      const key = randomUUID()
      await service.continueJob({
        actor: { username: 'u1', requestId: 'r1' },
        jobId: 'job-1',
        expectedRevision: 2,
        idempotencyKey: key
      })
      rawDb
        .prepare(
          `INSERT INTO control_jobs (
            id, thread_id, project_id, draft_message_id, state, state_revision,
            control_intent, execution_generation, active_run_id, title, requirements_summary,
            created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'job-2',
          'thread-2',
          'project-1',
          'draft-2',
          'execution_queued',
          1,
          'none',
          0,
          null,
          'Job 2',
          '',
          Date.now(),
          Date.now()
        )
      await assert.rejects(
        () =>
          service.requestPause({
            actor: { username: 'u1', requestId: 'r2' },
            jobId: 'job-2',
            expectedRevision: 1,
            idempotencyKey: key
          }),
        /idempotency_key_reused/
      )
    })
  })

  describe('transaction boundaries', () => {
    it('should not call runtime in transaction', async () => {
      seedJob(rawDb, {
        state: 'execution_running',
        stateRevision: 1,
        activeRunId: 'run-1'
      })
      seedRun(rawDb)
      const result = await service.cancelJob({
        actor: { username: 'u1', requestId: 'r1' },
        jobId: 'job-1',
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        payload: { reasonCode: 'user_cancelled' }
      })
      assert.equal(result.job.state, 'cancelled')
      await new Promise((r) => setTimeout(r, 10))
      assert.equal(runtimeStops.length, 1)
    })
  })
})
