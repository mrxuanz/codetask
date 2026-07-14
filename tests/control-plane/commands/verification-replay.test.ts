import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { runMigrations } from '../../../src/server/db/migrations/runner'
import { allMigrations } from '../../../src/server/db/migrations/index'
import { controlPlaneSchema } from '../../../src/server/infra/sqlite/control-plane/schema'
import { createControlPlaneTransaction } from '../../../src/server/infra/sqlite/control-plane/sqlite-control-plane-unit-of-work'
import { InternalExecutionCommandServiceImpl } from '../../../src/server/application/internal-execution-command-service'
import { SafeLoggerImpl } from '../../../src/server/application/safe-logger'
import { seedOwnedThreadJob } from '../fixtures/seed-owned-thread-job'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db, allMigrations)
  return db
}

function seedExecutionJob(db: Database.Database): void {
  const now = Date.now()
  seedOwnedThreadJob(db, { jobId: 'job-1', username: 'u1', status: 'running' })
  db.prepare(
    `INSERT INTO control_jobs (
      id, thread_id, project_id, draft_message_id, state, state_revision,
      control_intent, resume_target, current_plan_revision, execution_generation,
      active_run_id, title, requirements_summary, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'execution_running', 1, 'none', NULL, 1, 0, 'run-1', 'Test', '', ?, ?)`
  ).run('job-1', 'thread-job-1', 'project-job-1', 'draft-job-1', now, now)
  db.prepare(
    `INSERT INTO control_job_runs (
      id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms
    ) VALUES ('run-1', 'job-1', 'execution', 'active', 1, 'fence-1', 0, ?)`
  ).run(now)
  db.prepare(
    `INSERT INTO control_plan_revisions (id, job_id, plan_revision, status, content_hash, created_at_ms)
     VALUES ('plan-1', 'job-1', 1, 'confirmed', 'hash-1', ?)`
  ).run(now)
}

describe('verification replay (CR5)', () => {
  let rawDb: Database.Database
  let service: InternalExecutionCommandServiceImpl

  beforeEach(() => {
    rawDb = createTestDb()
    seedExecutionJob(rawDb)
    const drizzleDb = drizzle(rawDb, { schema: controlPlaneSchema })
    const controlPlane = createControlPlaneTransaction(drizzleDb)
    service = new InternalExecutionCommandServiceImpl({
      unitOfWork: controlPlane,
      clock: { nowMs: () => 1_700_000_000_000 },
      idGenerator: { generate: () => randomUUID() },
      logger: new SafeLoggerImpl()
    })
  })

  it('completes the running verification row and replays the same receipt', () => {
    const started = service.startVerification({
      jobId: 'job-1',
      expectedRevision: 1,
      runId: 'run-1',
      fenceToken: 'fence-1',
      executionGeneration: 0,
      payload: { scopeType: 'slice', scopeId: 'slice-1' }
    })

    const verdict = { passed: true, checks: ['lint'] }
    const completeInput = {
      jobId: 'job-1',
      expectedRevision: 2,
      runId: 'run-1',
      fenceToken: 'fence-1',
      executionGeneration: 0,
      payload: {
        verificationId: started.verificationId,
        scopeId: 'slice-1',
        verdict
      }
    }

    const first = service.completeSliceVerification(completeInput)
    const replay = service.completeSliceVerification(completeInput)

    assert.equal(first.verificationId, started.verificationId)
    assert.equal(replay.verificationId, started.verificationId)
    assert.equal(first.revision, replay.revision)
    assert.equal(first.state, 'passed')

    const rows = rawDb
      .prepare(
        `SELECT id, attempt_no, state, result_revision, verdict_blob_hash
         FROM control_verifications
         WHERE job_id = 'job-1' AND scope_id = 'slice-1'`
      )
      .all() as Array<{
      id: string
      attempt_no: number
      state: string
      result_revision: number
      verdict_blob_hash: string
    }>

    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.attempt_no, 1)
    assert.equal(rows[0]?.state, 'passed')
    assert.ok(rows[0]?.verdict_blob_hash)
    assert.equal(rows[0]?.result_revision, first.revision)
  })

  it('rejects a conflicting verdict hash for the same verification', () => {
    const started = service.startVerification({
      jobId: 'job-1',
      expectedRevision: 1,
      runId: 'run-1',
      fenceToken: 'fence-1',
      executionGeneration: 0,
      payload: { scopeType: 'slice', scopeId: 'slice-1' }
    })

    service.completeSliceVerification({
      jobId: 'job-1',
      expectedRevision: 2,
      runId: 'run-1',
      fenceToken: 'fence-1',
      executionGeneration: 0,
      payload: {
        verificationId: started.verificationId,
        scopeId: 'slice-1',
        verdict: { passed: true }
      }
    })

    assert.throws(
      () =>
        service.completeSliceVerification({
          jobId: 'job-1',
          expectedRevision: 3,
          runId: 'run-1',
          fenceToken: 'fence-1',
          executionGeneration: 0,
          payload: {
            verificationId: started.verificationId,
            scopeId: 'slice-1',
            verdict: { passed: false }
          }
        }),
      /verification.result_conflict/
    )
  })
})
