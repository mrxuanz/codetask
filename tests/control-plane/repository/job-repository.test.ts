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
      control_intent, execution_generation, active_run_id, title, requirements_summary,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    jobId,
    `thread-${jobId}`,
    `project-${jobId}`,
    `draft-${jobId}`,
    opts.state ?? 'execution_queued',
    opts.stateRevision ?? 1,
    opts.controlIntent ?? 'none',
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
      id, job_id, kind, state, attempt_no, fence_token, execution_generation,
      started_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id ?? 'run-1',
    opts.jobId ?? 'job-1',
    'execution',
    opts.state ?? 'active',
    1,
    opts.fenceToken ?? 'fence-uuid-1',
    opts.executionGeneration ?? 0,
    now
  )
}

describe('JobRepository', () => {
  let rawDb: Database.Database
  let repo: SqliteJobRepository
  let controlPlane: ReturnType<typeof createControlPlaneTransaction>

  beforeEach(() => {
    rawDb = createTestDb()
    const drizzleDb = drizzle(rawDb, { schema: controlPlaneSchema })
    controlPlane = createControlPlaneTransaction(drizzleDb)
    repo = controlPlane.jobs
  })

  describe('compareAndSetJob', () => {
    it('should succeed with correct revision and state', () => {
      seedJob(rawDb, { id: 'job-1', stateRevision: 1, state: 'execution_queued' })

      const result = repo.compareAndSetJob({
        jobId: 'job-1',
        updatedAtMs: Date.now(),
        expectedRevision: 1,
        expectedState: 'execution_queued',
        expectedActiveRunId: null,
        next: {
          state: 'execution_running',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: 'run-1',
          lastFailureId: null,
          terminalAtMs: null
        }
      })

      assert.equal(result.ok, true)
      if (result.ok) assert.equal(result.newRevision, 2)
    })

    it('should fail with stale revision', () => {
      seedJob(rawDb, { id: 'job-1', stateRevision: 3, state: 'execution_queued' })

      const result = repo.compareAndSetJob({
        jobId: 'job-1',
        updatedAtMs: Date.now(),
        expectedRevision: 1,
        expectedState: 'execution_queued',
        expectedActiveRunId: null,
        next: {
          state: 'execution_running',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: null,
          terminalAtMs: null
        }
      })

      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.reason, 'revision_conflict')
    })

    it('should fail with wrong state', () => {
      seedJob(rawDb, { id: 'job-1', stateRevision: 1, state: 'execution_queued' })

      const result = repo.compareAndSetJob({
        jobId: 'job-1',
        updatedAtMs: Date.now(),
        expectedRevision: 1,
        expectedState: 'execution_running',
        expectedActiveRunId: null,
        next: {
          state: 'paused',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: null,
          terminalAtMs: null
        }
      })

      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.reason, 'revision_conflict')
    })

    it('should fail with wrong active_run_id', () => {
      seedJob(rawDb, {
        id: 'job-1',
        stateRevision: 1,
        state: 'execution_running',
        activeRunId: 'run-1'
      })

      const result = repo.compareAndSetJob({
        jobId: 'job-1',
        updatedAtMs: Date.now(),
        expectedRevision: 1,
        expectedState: 'execution_running',
        expectedActiveRunId: 'run-2',
        next: {
          state: 'cancelled',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: null,
          terminalAtMs: Date.now()
        }
      })

      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.reason, 'revision_conflict')
    })

    it('should allow only one concurrent CAS to succeed', () => {
      seedJob(rawDb, { id: 'job-1', stateRevision: 1, state: 'execution_queued' })

      const result1 = repo.compareAndSetJob({
        jobId: 'job-1',
        updatedAtMs: Date.now(),
        expectedRevision: 1,
        expectedState: 'execution_queued',
        expectedActiveRunId: null,
        next: {
          state: 'execution_running',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: 'run-1',
          lastFailureId: null,
          terminalAtMs: null
        }
      })

      const result2 = repo.compareAndSetJob({
        jobId: 'job-1',
        updatedAtMs: Date.now(),
        expectedRevision: 1,
        expectedState: 'execution_queued',
        expectedActiveRunId: null,
        next: {
          state: 'execution_running',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: 'run-2',
          lastFailureId: null,
          terminalAtMs: null
        }
      })

      const successCount = [result1, result2].filter((r) => r.ok).length
      assert.equal(successCount, 1)
    })
  })

  describe('ownership', () => {
    it('should hide jobs from other users', () => {
      seedJob(rawDb, { id: 'job-1', username: 'owner-1' })

      const hidden = repo.getOwnedAggregate({
        actor: { username: 'owner-2', requestId: 'r1' },
        jobId: 'job-1'
      })

      assert.equal(hidden, null)
    })

    it('should list only actor-owned jobs', () => {
      seedJob(rawDb, { id: 'job-1', username: 'owner-1' })
      seedJob(rawDb, { id: 'job-2', username: 'owner-2' })

      const jobs = repo.listOwnedAggregates({
        actor: { username: 'owner-1', requestId: 'r1' }
      })

      assert.deepEqual(jobs.map((job) => job.id), ['job-1'])
    })
  })

  describe('worker fence', () => {
    it('should succeed with correct fence token', () => {
      seedJob(rawDb, {
        id: 'job-1',
        stateRevision: 1,
        state: 'execution_running',
        activeRunId: 'run-1'
      })
      seedRun(rawDb, { id: 'run-1', jobId: 'job-1', fenceToken: 'fence-1' })

      const result = repo.workerFence({
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        updatedAtMs: Date.now()
      })

      assert.equal(result.ok, true)
      if (result.ok) assert.equal(result.newRevision, 2)
    })

    it('should fail with stale run ID', () => {
      seedJob(rawDb, {
        id: 'job-1',
        stateRevision: 1,
        state: 'execution_running',
        activeRunId: 'run-1'
      })
      seedRun(rawDb, { id: 'run-1', jobId: 'job-1', fenceToken: 'fence-1' })

      const result = repo.workerFence({
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-stale',
        fenceToken: 'fence-1',
        executionGeneration: 0,
        updatedAtMs: Date.now()
      })

      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.reason, 'revision_conflict')
    })

    it('should fail with wrong fence token', () => {
      seedJob(rawDb, {
        id: 'job-1',
        stateRevision: 1,
        state: 'execution_running',
        activeRunId: 'run-1'
      })
      seedRun(rawDb, { id: 'run-1', jobId: 'job-1', fenceToken: 'fence-1' })

      const result = repo.workerFence({
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-wrong',
        executionGeneration: 0,
        updatedAtMs: Date.now()
      })

      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.reason, 'fence_mismatch')
    })

    it('should fail with old generation', () => {
      seedJob(rawDb, {
        id: 'job-1',
        stateRevision: 1,
        state: 'execution_running',
        activeRunId: 'run-1',
        executionGeneration: 2
      })
      seedRun(rawDb, { id: 'run-1', jobId: 'job-1', executionGeneration: 2 })

      const result = repo.workerFence({
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-uuid-1',
        executionGeneration: 1,
        updatedAtMs: Date.now()
      })

      assert.equal(result.ok, false)
    })

    it('should fail after cancel clears active run', () => {
      seedJob(rawDb, {
        id: 'job-1',
        stateRevision: 1,
        state: 'cancelled',
        activeRunId: null
      })
      seedRun(rawDb, { id: 'run-1', jobId: 'job-1', state: 'cancelled' })

      const result = repo.workerFence({
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-uuid-1',
        executionGeneration: 0,
        updatedAtMs: Date.now()
      })

      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.reason, 'stale_run')
    })
  })

  describe('dedup', () => {
    it('should return stored result for same key and hash', () => {
      const now = Date.now()
      controlPlane.dedup.storeDedup({
        actorUsername: 'alice',
        idempotencyKey: 'key-1',
        commandType: 'request_pause',
        requestHash: 'hash-1',
        response: { ok: true },
        responseRevision: 2,
        createdAtMs: now,
        expiresAtMs: now + 60_000
      })

      const result = controlPlane.dedup.getDedup({
        actorUsername: 'alice',
        commandType: 'request_pause',
        idempotencyKey: 'key-1'
      })

      assert.notEqual(result, null)
      if (result) {
        assert.equal(result.requestHash, 'hash-1')
        assert.equal(result.responseRevision, 2)
      }
    })

    it('should return null for unknown key', () => {
      const result = controlPlane.dedup.getDedup({
        actorUsername: 'alice',
        commandType: 'request_pause',
        idempotencyKey: 'unknown-key'
      })

      assert.equal(result, null)
    })

    it('should detect key reuse with different hash', () => {
      const now = Date.now()
      controlPlane.dedup.storeDedup({
        actorUsername: 'alice',
        idempotencyKey: 'key-1',
        commandType: 'request_pause',
        requestHash: 'hash-1',
        response: { ok: true },
        responseRevision: 2,
        createdAtMs: now,
        expiresAtMs: now + 60_000
      })

      const stored = controlPlane.dedup.getDedup({
        actorUsername: 'alice',
        commandType: 'request_pause',
        idempotencyKey: 'key-1'
      })

      assert.notEqual(stored, null)
      if (stored) {
        assert.notEqual(stored.requestHash, 'hash-different')
      }
    })
  })

  describe('outbox visibility', () => {
    it('should replay only actor-owned outbox events', () => {
      seedJob(rawDb, { id: 'job-1', username: 'owner-1' })
      seedJob(rawDb, { id: 'job-2', username: 'owner-2' })

      controlPlane.outbox.appendOutbox({
        topic: 'job:job-1',
        eventType: 'job.changed',
        entityId: 'job-1',
        aggregateRevision: 2,
        createdAtMs: Date.now(),
        payload: { type: 'job.changed', entityId: 'job-1', revision: 2, changed: ['state'] }
      })
      controlPlane.outbox.appendOutbox({
        topic: 'job:job-2',
        eventType: 'job.changed',
        entityId: 'job-2',
        aggregateRevision: 2,
        createdAtMs: Date.now(),
        payload: { type: 'job.changed', entityId: 'job-2', revision: 2, changed: ['state'] }
      })

      const visible = controlPlane.outbox.listOwnedOutboxEvents({
        actor: { username: 'owner-1', requestId: 'r1' },
        afterEventId: 0,
        limit: 10
      })

      assert.deepEqual(visible.map((event) => event.entityId), ['job-1'])
    })

    it('should expose latest visible event id for actor cursor reset', () => {
      seedJob(rawDb, { id: 'job-1', username: 'owner-1' })
      seedJob(rawDb, { id: 'job-2', username: 'owner-2' })

      controlPlane.outbox.appendOutbox({
        topic: 'job:job-2',
        eventType: 'job.changed',
        entityId: 'job-2',
        aggregateRevision: 2,
        createdAtMs: Date.now(),
        payload: { type: 'job.changed', entityId: 'job-2', revision: 2, changed: ['state'] }
      })
      controlPlane.outbox.appendOutbox({
        topic: 'job:job-1',
        eventType: 'job.changed',
        entityId: 'job-1',
        aggregateRevision: 2,
        createdAtMs: Date.now(),
        payload: { type: 'job.changed', entityId: 'job-1', revision: 2, changed: ['state'] }
      })

      const latestOwner1 = controlPlane.outbox.getOwnedOutboxLatestEventId({
        actor: { username: 'owner-1', requestId: 'r1' }
      })
      const latestOwner2 = controlPlane.outbox.getOwnedOutboxLatestEventId({
        actor: { username: 'owner-2', requestId: 'r2' }
      })

      assert.equal(latestOwner1, 2)
      assert.equal(latestOwner2, 1)
    })
  })

  describe('slot release', () => {
    it('should release control resource slot by run id', () => {
      seedJob(rawDb, { id: 'job-1', state: 'execution_running', activeRunId: 'run-1' })
      seedRun(rawDb, { id: 'run-1', jobId: 'job-1' })
      const now = Date.now()
      controlPlane.slots.createSlot({
        id: randomUUID(),
        jobId: 'job-1',
        runId: 'run-1',
        pool: 'default',
        createdAtMs: now
      })

      controlPlane.slots.releaseSlot({ runId: 'run-1', releasedAtMs: now })

      const row = rawDb
        .prepare(`SELECT state, released_at_ms FROM control_resource_slots WHERE run_id = ?`)
        .get('run-1') as { state: string; released_at_ms: number | null } | undefined

      assert.equal(row?.state, 'released')
      assert.ok((row?.released_at_ms ?? 0) > 0)
    })
  })
})
