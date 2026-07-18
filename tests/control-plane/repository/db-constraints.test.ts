import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/server/db/migrations/runner'
import { allMigrations } from '../../../src/server/db/migrations/index'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db, allMigrations)
  return db
}

function seedPlanRevision(db: Database.Database, jobId = 'job-1', planRevision = 1): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO control_plan_revisions (id, job_id, plan_revision, status, content_hash, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`plan-${jobId}-${planRevision}`, jobId, planRevision, 'confirmed', 'hash-1', now)
}

function insertJob(
  db: Database.Database,
  opts: {
    id?: string
    state?: string
    stateRevision?: number
    controlIntent?: string
    threadId?: string
    draftMessageId?: string
    executionGeneration?: number
  } = {}
): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO control_jobs (
      id, thread_id, project_id, draft_message_id, state, state_revision,
      control_intent, execution_generation, title, requirements_summary,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id ?? 'job-1',
    opts.threadId ?? 'thread-1',
    'project-1',
    opts.draftMessageId ?? 'draft-1',
    opts.state ?? 'execution_queued',
    opts.stateRevision ?? 1,
    opts.controlIntent ?? 'none',
    opts.executionGeneration ?? 0,
    'Test Job',
    'Test summary',
    now,
    now
  )
}

describe('DB Constraints', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
  })

  describe('control_jobs', () => {
    it('should reject invalid state', () => {
      assert.throws(
        () => insertJob(db, { state: 'invalid_state' }),
        /CHECK/
      )
    })

    it('should reject negative revision', () => {
      assert.throws(
        () => insertJob(db, { stateRevision: -1 }),
        /CHECK/
      )
    })

    it('should reject invalid control_intent', () => {
      assert.throws(
        () => insertJob(db, { controlIntent: 'invalid' }),
        /CHECK/
      )
    })

    it('should reject duplicate thread_id + draft_message_id', () => {
      insertJob(db, { threadId: 't1', draftMessageId: 'd1' })
      assert.throws(
        () => insertJob(db, { id: 'job-2', threadId: 't1', draftMessageId: 'd1' }),
        /UNIQUE/
      )
    })
  })

  describe('control_job_runs', () => {
    it('should reject duplicate (job_id, fence_token)', () => {
      insertJob(db)
      const now = Date.now()
      db.prepare(
        `INSERT INTO control_job_runs (id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('run-1', 'job-1', 'execution', 'active', 1, 'fence-1', 0, now)

      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO control_job_runs (id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run('run-2', 'job-1', 'execution', 'active', 1, 'fence-1', 0, now),
        /UNIQUE/
      )
    })

    it('should reject negative attempt_no', () => {
      insertJob(db)
      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO control_job_runs (id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run('run-1', 'job-1', 'execution', 'active', -1, 'fence-1', 0, Date.now()),
        /CHECK/
      )
    })

    it('should reject negative execution_generation', () => {
      insertJob(db)
      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO control_job_runs (id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run('run-1', 'job-1', 'execution', 'active', 1, 'fence-1', -1, Date.now()),
        /CHECK/
      )
    })
  })

  describe('control_resource_slots', () => {
    it('should reject two active slots for same job', () => {
      insertJob(db)
      const now = Date.now()
      db.prepare(
        `INSERT INTO control_job_runs (id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('run-1', 'job-1', 'execution', 'active', 1, 'fence-1', 0, now)

      db.prepare(
        `INSERT INTO control_resource_slots (id, job_id, run_id, pool, state, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('slot-1', 'job-1', 'run-1', 'default', 'active', now)

      db.prepare(
        `INSERT INTO control_job_runs (id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('run-2', 'job-1', 'execution', 'active', 2, 'fence-2', 0, now)

      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO control_resource_slots (id, job_id, run_id, pool, state, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run('slot-2', 'job-1', 'run-2', 'default', 'active', now),
        /UNIQUE/
      )
    })

    it('should allow released and active slots for same job', () => {
      insertJob(db)
      const now = Date.now()

      db.prepare(
        `INSERT INTO control_job_runs (id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('run-1', 'job-1', 'execution', 'succeeded', 1, 'fence-1', 0, now)

      db.prepare(
        `INSERT INTO control_resource_slots (id, job_id, run_id, pool, state, created_at_ms, released_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('slot-1', 'job-1', 'run-1', 'default', 'released', now, now)

      db.prepare(
        `INSERT INTO control_job_runs (id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('run-2', 'job-1', 'execution', 'active', 2, 'fence-2', 0, now)

      db.prepare(
        `INSERT INTO control_resource_slots (id, job_id, run_id, pool, state, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('slot-2', 'job-1', 'run-2', 'default', 'active', now)

      const count = db
        .prepare(`SELECT COUNT(*) as cnt FROM control_resource_slots WHERE job_id = 'job-1'`)
        .get() as { cnt: number }
      assert.equal(count.cnt, 2)
    })
  })

  describe('control_runtime_instances', () => {
    it('should reject two active instances for same run', () => {
      insertJob(db)
      const now = Date.now()
      db.prepare(
        `INSERT INTO control_job_runs (id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('run-1', 'job-1', 'execution', 'active', 1, 'fence-1', 0, now)

      db.prepare(
        `INSERT INTO control_runtime_instances (id, run_id, state, owner_boot_id, started_at_ms)
         VALUES (?, ?, ?, ?, ?)`
      ).run('inst-1', 'run-1', 'active', 'boot-1', now)

      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO control_runtime_instances (id, run_id, state, owner_boot_id, started_at_ms)
             VALUES (?, ?, ?, ?, ?)`
          ).run('inst-2', 'run-1', 'active', 'boot-1', now),
        /UNIQUE/
      )
    })

    it('should allow closed and active instances for same run', () => {
      insertJob(db)
      const now = Date.now()
      db.prepare(
        `INSERT INTO control_job_runs (id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('run-1', 'job-1', 'execution', 'active', 1, 'fence-1', 0, now)

      db.prepare(
        `INSERT INTO control_runtime_instances (id, run_id, state, owner_boot_id, started_at_ms, closed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('inst-1', 'run-1', 'closed', 'boot-1', now, now)

      db.prepare(
        `INSERT INTO control_runtime_instances (id, run_id, state, owner_boot_id, started_at_ms)
         VALUES (?, ?, ?, ?, ?)`
      ).run('inst-2', 'run-1', 'active', 'boot-2', now)

      const count = db
        .prepare(`SELECT COUNT(*) as cnt FROM control_runtime_instances WHERE run_id = 'run-1'`)
        .get() as { cnt: number }
      assert.equal(count.cnt, 2)
    })
  })

  describe('control_verifications', () => {
    it('should reject duplicate composite key', () => {
      insertJob(db)
      seedPlanRevision(db)
      const now = Date.now()
      db.prepare(
        `INSERT INTO control_verifications (
          id, job_id, execution_generation, plan_revision, scope_type, scope_id,
          attempt_no, state, started_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('v-1', 'job-1', 0, 1, 'slice', 'slice-1', 1, 'running', now)

      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO control_verifications (
              id, job_id, execution_generation, plan_revision, scope_type, scope_id,
              attempt_no, state, started_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run('v-2', 'job-1', 0, 1, 'slice', 'slice-1', 1, 'running', now),
        /UNIQUE/
      )
    })

    it('should reject passed without verdict_blob_hash', () => {
      insertJob(db)
      seedPlanRevision(db)
      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO control_verifications (
              id, job_id, execution_generation, plan_revision, scope_type, scope_id,
              attempt_no, state, result_hash, started_at_ms, ended_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run('v-1', 'job-1', 0, 1, 'slice', 'slice-1', 1, 'passed', 'hash-1', Date.now(), Date.now()),
        /CHECK/
      )
    })

    it('should reject passed without result_hash', () => {
      insertJob(db)
      seedPlanRevision(db)
      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO control_verifications (
              id, job_id, execution_generation, plan_revision, scope_type, scope_id,
              attempt_no, state, verdict_blob_hash, started_at_ms, ended_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run('v-1', 'job-1', 0, 1, 'slice', 'slice-1', 1, 'passed', 'verdict-1', Date.now(), Date.now()),
        /CHECK/
      )
    })

    it('should reject passed without ended_at_ms', () => {
      insertJob(db)
      seedPlanRevision(db)
      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO control_verifications (
              id, job_id, execution_generation, plan_revision, scope_type, scope_id,
              attempt_no, state, verdict_blob_hash, result_hash, started_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run('v-1', 'job-1', 0, 1, 'slice', 'slice-1', 1, 'passed', 'verdict-1', 'hash-1', Date.now()),
        /CHECK/
      )
    })
  })

  describe('foreign key checks', () => {
    it('should pass PRAGMA foreign_key_check', () => {
      const result = db.prepare('PRAGMA foreign_key_check').all()
      assert.equal(result.length, 0)
    })
  })
})
