import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'

import { SqliteJobRepository } from '../../../src/server/infra/sqlite/control-plane/job-repository'
import { createInvariantSweep } from '../../../src/server/infra/sqlite/control-plane/invariant-sweep'
import {
  controlJobs,
  controlJobRuns,
  controlJobFailures,
  controlOutboxEvents,
  controlCommandDedup,
  controlResourceSlots
} from '../../../src/server/infra/sqlite/control-plane/schema'
import type { Clock } from '../../../src/server/application/ports/clock'
import type { IdGenerator } from '../../../src/server/application/ports/id-generator'
import type {
  JobCasInput,
  InsertFailureInput,
  AppendOutboxInput,
  StoreDedupInput,
  WorkerFence
} from '../../../src/server/application/ports/job-repository'
import type { JobState, ControlIntent, ResumeTarget } from '../../../src/shared/contracts/control-plane/primitives'

// ─── Test-only schema (projects + control-plane tables) ─────────────────────

const projects = {
  id: 'id',
  username: 'username'
} as const

const testSchema = {
  controlJobs,
  controlJobRuns,
  controlJobFailures,
  controlOutboxEvents,
  controlCommandDedup,
  controlResourceSlots
}

type TestDatabase = ReturnType<typeof drizzle<typeof testSchema>>

// ─── Control-plane DDL (mirrors schema.ts CHECK constraints) ────────────────

const CONTROL_PLANE_DDL = `
CREATE TABLE IF NOT EXISTS control_jobs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  draft_message_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('planning_queued','planning_running','plan_review','execution_queued','execution_running','pausing','paused','applying_changes','succeeded','failed','cancelled')),
  state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
  control_intent TEXT NOT NULL CHECK (control_intent IN ('none', 'pause')),
  resume_target TEXT
    CHECK (resume_target IS NULL OR resume_target IN ('planning_queued', 'execution_queued')),
  current_plan_revision INTEGER CHECK (current_plan_revision IS NULL OR current_plan_revision >= 1),
  execution_generation INTEGER NOT NULL CHECK (execution_generation >= 0),
  active_run_id TEXT,
  last_failure_id TEXT,
  title TEXT NOT NULL,
  requirements_summary TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms NOT NULL CHECK (updated_at_ms >= 0),
  terminal_at_ms INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_jobs_thread_draft
  ON control_jobs(thread_id, draft_message_id);
CREATE INDEX IF NOT EXISTS idx_control_jobs_project_state
  ON control_jobs(project_id, state, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_control_jobs_scheduler
  ON control_jobs(state, control_intent, active_run_id, created_at_ms);

CREATE TABLE IF NOT EXISTS control_job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES control_jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('planning', 'execution')),
  state TEXT NOT NULL CHECK (state IN ('active', 'pausing', 'completed', 'failed', 'cancelled')),
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  fence_token TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation >= 0),
  lease_owner_boot_id TEXT,
  heartbeat_at_ms INTEGER CHECK (heartbeat_at_ms IS NULL OR heartbeat_at_ms >= 0),
  stop_reason TEXT
    CHECK (stop_reason IS NULL OR stop_reason IN ('user_cancelled','app_shutdown','run_interrupted','run_failed','pause_checkpoint_failed')),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_job_runs_job_fence
  ON control_job_runs(job_id, fence_token);

CREATE TABLE IF NOT EXISTS control_job_failures (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  run_id TEXT,
  code TEXT NOT NULL,
  recoverability TEXT NOT NULL,
  reason TEXT,
  run_kind TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS control_outbox_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision >= 1),
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  dispatched_at_ms INTEGER CHECK (dispatched_at_ms IS NULL OR dispatched_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_control_outbox_events_dispatch
  ON control_outbox_events(dispatched_at_ms, event_id);
CREATE INDEX IF NOT EXISTS idx_control_outbox_events_topic
  ON control_outbox_events(topic, event_id);

CREATE TABLE IF NOT EXISTS control_command_dedup (
  actor_username TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  response_revision INTEGER NOT NULL CHECK (response_revision >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
  PRIMARY KEY(actor_username, idempotency_key)
);

CREATE TABLE IF NOT EXISTS control_resource_slots (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  pool TEXT NOT NULL,
  state TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_resource_slots_run_id
  ON control_resource_slots(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_resource_slots_job_active
  ON control_resource_slots(job_id, state) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_control_resource_slots_pool_state
  ON control_resource_slots(pool, state);
`

// ─── Test DB helper ─────────────────────────────────────────────────────────

function createTestDb(): TestDatabase {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  sqlite.exec(CONTROL_PLANE_DDL)
  return drizzle(sqlite, { schema: testSchema })
}

// ─── Fixture builders ───────────────────────────────────────────────────────

type JobFixture = {
  readonly id: string
  readonly threadId: string
  readonly projectId: string
  readonly draftMessageId: string
  readonly state: JobState
  readonly stateRevision: number
  readonly controlIntent: ControlIntent
  readonly resumeTarget: ResumeTarget | null
  readonly currentPlanRevision: number | null
  readonly executionGeneration: number
  readonly activeRunId: string | null
  readonly lastFailureId: string | null
  readonly title: string
  readonly requirementsSummary: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly terminalAtMs: number | null
}

function buildJobFixture(overrides?: Partial<JobFixture>): JobFixture {
  return {
    id: overrides?.id ?? 'job-1',
    threadId: overrides?.threadId ?? 'thread-1',
    projectId: overrides?.projectId ?? 'project-1',
    draftMessageId: overrides?.draftMessageId ?? 'draft-1',
    state: overrides?.state ?? 'execution_running',
    stateRevision: overrides?.stateRevision ?? 1,
    controlIntent: overrides?.controlIntent ?? 'none',
    resumeTarget: overrides?.resumeTarget === undefined ? null : overrides.resumeTarget,
    currentPlanRevision: overrides?.currentPlanRevision === undefined ? 1 : overrides.currentPlanRevision,
    executionGeneration: overrides?.executionGeneration ?? 1,
    activeRunId: overrides?.activeRunId === undefined ? null : overrides.activeRunId,
    lastFailureId: overrides?.lastFailureId === undefined ? null : overrides.lastFailureId,
    title: overrides?.title ?? 'Test Job',
    requirementsSummary: overrides?.requirementsSummary ?? 'test requirements',
    createdAtMs: overrides?.createdAtMs ?? 1000,
    updatedAtMs: overrides?.updatedAtMs ?? 1000,
    terminalAtMs: overrides?.terminalAtMs === undefined ? null : overrides.terminalAtMs
  }
}

type RunFixture = {
  readonly id: string
  readonly jobId: string
  readonly kind: 'planning' | 'execution'
  readonly state: 'active' | 'pausing' | 'completed' | 'failed' | 'cancelled'
  readonly attemptNo: number
  readonly fenceToken: string
  readonly executionGeneration: number
  readonly startedAtMs: number
  readonly endedAtMs: number | null
}

function buildRunFixture(overrides?: Partial<RunFixture>): RunFixture {
  return {
    id: overrides?.id ?? 'run-1',
    jobId: overrides?.jobId ?? 'job-1',
    kind: overrides?.kind ?? 'execution',
    state: overrides?.state ?? 'active',
    attemptNo: overrides?.attemptNo ?? 1,
    fenceToken: overrides?.fenceToken ?? 'fence-abc-123',
    executionGeneration: overrides?.executionGeneration ?? 1,
    startedAtMs: overrides?.startedAtMs ?? 1000,
    endedAtMs: overrides?.endedAtMs === undefined ? null : overrides.endedAtMs
  }
}

function insertProject(db: TestDatabase, projectId: string, username: string): void {
  const sqlite = (db as unknown as { $client: Database.Database }).$client
  sqlite.prepare(
    `INSERT INTO projects (id, username, title, workspace_root, created_at, updated_at)
     VALUES (?, ?, 'Test', '/tmp', 1000, 1000)`
  ).run(projectId, username)
}

function insertJob(db: TestDatabase, fixture: JobFixture): void {
  db.insert(controlJobs).values({
    id: fixture.id,
    threadId: fixture.threadId,
    projectId: fixture.projectId,
    draftMessageId: fixture.draftMessageId,
    state: fixture.state,
    stateRevision: fixture.stateRevision,
    controlIntent: fixture.controlIntent,
    resumeTarget: fixture.resumeTarget,
    currentPlanRevision: fixture.currentPlanRevision,
    executionGeneration: fixture.executionGeneration,
    activeRunId: fixture.activeRunId,
    lastFailureId: fixture.lastFailureId,
    title: fixture.title,
    requirementsSummary: fixture.requirementsSummary,
    createdAtMs: fixture.createdAtMs,
    updatedAtMs: fixture.updatedAtMs,
    terminalAtMs: fixture.terminalAtMs
  }).run()
}

function insertRun(db: TestDatabase, fixture: RunFixture): void {
  db.insert(controlJobRuns).values({
    id: fixture.id,
    jobId: fixture.jobId,
    kind: fixture.kind,
    state: fixture.state,
    attemptNo: fixture.attemptNo,
    fenceToken: fixture.fenceToken,
    executionGeneration: fixture.executionGeneration,
    startedAtMs: fixture.startedAtMs,
    endedAtMs: fixture.endedAtMs
  }).run()
}

function getJobStateRevision(db: TestDatabase, jobId: string): number {
  const rows = db
    .select({ stateRevision: controlJobs.stateRevision })
    .from(controlJobs)
    .where(eq(controlJobs.id, jobId))
    .all()
  assert.equal(rows.length, 1, `job ${jobId} not found`)
  return rows[0].stateRevision
}

function getJobActiveRunId(db: TestDatabase, jobId: string): string | null {
  const rows = db
    .select({ activeRunId: controlJobs.activeRunId })
    .from(controlJobs)
    .where(eq(controlJobs.id, jobId))
    .all()
  assert.equal(rows.length, 1, `job ${jobId} not found`)
  return rows[0].activeRunId
}

// ─── Test doubles ───────────────────────────────────────────────────────────

function createTestClock(now: number = 5000): Clock {
  return { nowMs: () => now }
}

function createTestIdGenerator(): IdGenerator {
  let counter = 0
  return {
    newId: () => `gen-id-${++counter}`,
    newFenceToken: () => `gen-fence-${++counter}`
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('job-repository', () => {
  describe('compareAndSetJob', () => {
    it('stale revision affects 0 rows → revision_conflict', () => {
      const db = createTestDb()
      insertProject(db, 'project-1', 'user-1')
      insertJob(db, buildJobFixture({ stateRevision: 3 }))

      const repo = new SqliteJobRepository(createTestClock(), createTestIdGenerator())
      const casInput: JobCasInput = {
        jobId: 'job-1',
        expectedRevision: 2, // stale: actual is 3
        expectedState: 'execution_running',
        expectedActiveRunId: null,
        next: {
          state: 'execution_running',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: null,
          terminalAtMs: null
        }
      }

      const result = repo.compareAndSetJob(db, casInput)
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.reason, 'revision_conflict')
      }
      assert.equal(getJobStateRevision(db, 'job-1'), 3, 'revision must not change')
    })

    it('stale run ID affects 0 rows → revision_conflict', () => {
      const db = createTestDb()
      insertProject(db, 'project-1', 'user-1')
      insertJob(db, buildJobFixture({
        state: 'pausing',
        controlIntent: 'pause',
        resumeTarget: 'execution_queued',
        activeRunId: 'run-correct'
      }))

      const repo = new SqliteJobRepository(createTestClock(), createTestIdGenerator())
      const casInput: JobCasInput = {
        jobId: 'job-1',
        expectedRevision: 1,
        expectedState: 'pausing',
        expectedActiveRunId: 'run-stale', // stale: actual is 'run-correct'
        next: {
          state: 'paused',
          controlIntent: 'none',
          resumeTarget: 'execution_queued',
          activeRunId: null,
          lastFailureId: null,
          terminalAtMs: null
        }
      }

      const result = repo.compareAndSetJob(db, casInput)
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.reason, 'revision_conflict')
      }
      assert.equal(getJobActiveRunId(db, 'job-1'), 'run-correct', 'active run must not change')
    })
  })

  describe('fenceWorker', () => {
    it('correct run + wrong fence token affects 0 rows → returns false', () => {
      const db = createTestDb()
      insertProject(db, 'project-1', 'user-1')
      insertJob(db, buildJobFixture({
        state: 'execution_running',
        activeRunId: 'run-1',
        executionGeneration: 1
      }))
      insertRun(db, buildRunFixture({
        id: 'run-1',
        fenceToken: 'fence-real',
        state: 'active'
      }))

      const repo = new SqliteJobRepository(createTestClock(), createTestIdGenerator())
      const fence: WorkerFence = {
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-wrong', // wrong fence
        executionGeneration: 1
      }

      const success = repo.fenceWorker(db, fence)
      assert.equal(success, false, 'wrong fence must fail')
      assert.equal(getJobStateRevision(db, 'job-1'), 1, 'revision must not change')
    })

    it('correct fence + old generation affects 0 rows → returns false', () => {
      const db = createTestDb()
      insertProject(db, 'project-1', 'user-1')
      insertJob(db, buildJobFixture({
        state: 'execution_running',
        activeRunId: 'run-1',
        executionGeneration: 2 // current generation
      }))
      insertRun(db, buildRunFixture({
        id: 'run-1',
        fenceToken: 'fence-abc',
        executionGeneration: 2 // run is also gen 2
      }))

      const repo = new SqliteJobRepository(createTestClock(), createTestIdGenerator())
      const fence: WorkerFence = {
        jobId: 'job-1',
        expectedRevision: 1,
        runId: 'run-1',
        fenceToken: 'fence-abc',
        executionGeneration: 1 // old generation: actual is 2
      }

      const success = repo.fenceWorker(db, fence)
      assert.equal(success, false, 'old generation must fail')
      assert.equal(getJobStateRevision(db, 'job-1'), 1, 'revision must not change')
    })

    it('cancel clears active run → old worker forever rejected', () => {
      const db = createTestDb()
      insertProject(db, 'project-1', 'user-1')
      insertJob(db, buildJobFixture({
        state: 'execution_running',
        activeRunId: 'run-1',
        executionGeneration: 1
      }))
      insertRun(db, buildRunFixture({
        id: 'run-1',
        fenceToken: 'fence-abc',
        state: 'active'
      }))

      const repo = new SqliteJobRepository(createTestClock(), createTestIdGenerator())

      // Cancel the job: clears active_run_id
      const cancelInput: JobCasInput = {
        jobId: 'job-1',
        expectedRevision: 1,
        expectedState: 'execution_running',
        expectedActiveRunId: 'run-1',
        next: {
          state: 'cancelled',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: null,
          terminalAtMs: 5000
        }
      }

      const cancelResult = repo.compareAndSetJob(db, cancelInput)
      assert.equal(cancelResult.ok, true, 'cancel must succeed')
      assert.equal(getJobActiveRunId(db, 'job-1'), null, 'active run must be cleared')

      // Old worker tries to fence — must fail forever
      const fence: WorkerFence = {
        jobId: 'job-1',
        expectedRevision: 1, // old revision
        runId: 'run-1',
        fenceToken: 'fence-abc',
        executionGeneration: 1
      }

      const fenceResult = repo.fenceWorker(db, fence)
      assert.equal(fenceResult, false, 'old worker must be rejected after cancel')
    })
  })

  describe('concurrent CAS', () => {
    it('two transactions same expected revision → only one succeeds', () => {
      const db = createTestDb()
      insertProject(db, 'project-1', 'user-1')
      insertJob(db, buildJobFixture({
        state: 'execution_running',
        stateRevision: 5,
        activeRunId: 'run-1'
      }))

      const repo = new SqliteJobRepository(createTestClock(), createTestIdGenerator())

      const casInputA: JobCasInput = {
        jobId: 'job-1',
        expectedRevision: 5,
        expectedState: 'execution_running',
        expectedActiveRunId: 'run-1',
        next: {
          state: 'pausing',
          controlIntent: 'pause',
          resumeTarget: 'execution_queued',
          activeRunId: 'run-1',
          lastFailureId: null,
          terminalAtMs: null
        }
      }

      const casInputB: JobCasInput = {
        jobId: 'job-1',
        expectedRevision: 5,
        expectedState: 'execution_running',
        expectedActiveRunId: 'run-1',
        next: {
          state: 'cancelled',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: null,
          terminalAtMs: 5000
        }
      }

      // Transaction A succeeds
      const resultA = repo.compareAndSetJob(db, casInputA)
      assert.equal(resultA.ok, true, 'first CAS must succeed')
      if (resultA.ok) {
        assert.equal(resultA.newRevision, 6)
      }

      // Transaction B fails (stale revision — now actual is 6)
      const resultB = repo.compareAndSetJob(db, casInputB)
      assert.equal(resultB.ok, false, 'second CAS must fail')
      if (!resultB.ok) {
        assert.equal(resultB.reason, 'revision_conflict')
      }

      // Only A's state applied
      assert.equal(getJobStateRevision(db, 'job-1'), 6)
    })
  })

  describe('DB CHECK constraints', () => {
    it('CHECK rejects invalid state enum', () => {
      const db = createTestDb()
      const sqlite = (db as unknown as { $client: Database.Database }).$client

      assert.throws(
        () => {
          sqlite.prepare(
            `INSERT INTO control_jobs
             (id, thread_id, project_id, draft_message_id, state, state_revision,
              control_intent, execution_generation, title, requirements_summary,
              created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            'job-bad', 'thread-1', 'project-1', 'draft-1',
            'invalid_state', // violates CHECK
            1, 'none', 0, 'Title', 'Summary', 1000, 1000
          )
        },
        (err: unknown) => err instanceof Error && err.message.includes('CHECK'),
        'invalid state must be rejected by CHECK constraint'
      )
    })

    it('CHECK rejects negative state_revision', () => {
      const db = createTestDb()
      const sqlite = (db as unknown as { $client: Database.Database }).$client

      assert.throws(
        () => {
          sqlite.prepare(
            `INSERT INTO control_jobs
             (id, thread_id, project_id, draft_message_id, state, state_revision,
              control_intent, execution_generation, title, requirements_summary,
              created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            'job-bad', 'thread-1', 'project-1', 'draft-1',
            'execution_queued',
            0, // violates CHECK >= 1
            'none', 0, 'Title', 'Summary', 1000, 1000
          )
        },
        (err: unknown) => err instanceof Error && err.message.includes('CHECK'),
        'negative revision must be rejected by CHECK constraint'
      )
    })

    it('CHECK rejects negative execution_generation', () => {
      const db = createTestDb()
      const sqlite = (db as unknown as { $client: Database.Database }).$client

      assert.throws(
        () => {
          sqlite.prepare(
            `INSERT INTO control_jobs
             (id, thread_id, project_id, draft_message_id, state, state_revision,
              control_intent, execution_generation, title, requirements_summary,
              created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            'job-bad', 'thread-1', 'project-1', 'draft-1',
            'execution_queued',
            1, 'none',
            -1, // violates CHECK >= 0
            'Title', 'Summary', 1000, 1000
          )
        },
        (err: unknown) => err instanceof Error && err.message.includes('CHECK'),
        'negative generation must be rejected by CHECK constraint'
      )
    })
  })

  describe('partial unique index', () => {
    it('rejects two active resource slots for the same job', () => {
      const db = createTestDb()
      const sqlite = (db as unknown as { $client: Database.Database }).$client

      // First active slot succeeds
      sqlite.prepare(
        `INSERT INTO control_resource_slots (id, job_id, run_id, pool, state)
         VALUES (?, ?, ?, ?, ?)`
      ).run('slot-1', 'job-1', 'run-1', 'default', 'active')

      // Second active slot for same job must fail (partial unique index)
      assert.throws(
        () => {
          sqlite.prepare(
            `INSERT INTO control_resource_slots (id, job_id, run_id, pool, state)
             VALUES (?, ?, ?, ?, ?)`
          ).run('slot-2', 'job-1', 'run-2', 'default', 'active')
        },
        (err: unknown) => err instanceof Error && err.message.includes('UNIQUE'),
        'partial unique index must reject two active slots for same job'
      )

      // Non-active slot for same job should succeed
      sqlite.prepare(
        `INSERT INTO control_resource_slots (id, job_id, run_id, pool, state)
         VALUES (?, ?, ?, ?, ?)`
      ).run('slot-3', 'job-1', 'run-3', 'default', 'released')

      const activeSlots = sqlite.prepare(
        `SELECT COUNT(*) as cnt FROM control_resource_slots WHERE job_id = ? AND state = 'active'`
      ).get('job-1') as { cnt: number }
      assert.equal(activeSlots.cnt, 1, 'only one active slot allowed per job')

      const totalSlots = sqlite.prepare(
        `SELECT COUNT(*) as cnt FROM control_resource_slots WHERE job_id = ?`
      ).get('job-1') as { cnt: number }
      assert.equal(totalSlots.cnt, 2, 'non-active slot coexists with active slot')
    })
  })

  describe('invariant sweep', () => {
    it('sweep on corrupted fixture (terminal + active run) → fail closed (quarantines)', () => {
      const db = createTestDb()
      insertProject(db, 'project-1', 'user-1')

      // Insert a valid state that violates invariants:
      // cancelled (terminal) with active_run_id set — violates job.terminal_has_active_run
      insertJob(db, buildJobFixture({
        id: 'job-corrupt',
        state: 'cancelled',
        controlIntent: 'none',
        activeRunId: 'run-ghost',
        terminalAtMs: 3000
      }))

      const sweep = createInvariantSweep(db)
      const quarantined = sweep.sweep()

      const found = quarantined.find((q) => q.jobId === 'job-corrupt')
      assert.ok(found, 'corrupted job must be quarantined')
      assert.ok(
        found.violations.some((v) => v.code === 'job.terminal_has_active_run'),
        'must detect terminal_has_active_run violation'
      )
    })

    it('sweep on valid jobs → no quarantines', () => {
      const db = createTestDb()
      insertProject(db, 'project-1', 'user-1')

      insertJob(db, buildJobFixture({
        id: 'job-valid',
        state: 'execution_running',
        activeRunId: 'run-valid',
        controlIntent: 'none'
      }))
      insertRun(db, buildRunFixture({
        id: 'run-valid',
        jobId: 'job-valid',
        state: 'active'
      }))

      const sweep = createInvariantSweep(db)
      const quarantined = sweep.sweep()

      const found = quarantined.find((q) => q.jobId === 'job-valid')
      assert.equal(found, undefined, 'valid job must not be quarantined')
    })

    it('sweep detects multiple violations on one job', () => {
      const db = createTestDb()
      insertProject(db, 'project-1', 'user-1')

      // paused with active_run_id and controlIntent=pause → two violations
      insertJob(db, buildJobFixture({
        id: 'job-multi',
        state: 'paused',
        controlIntent: 'pause', // violates paused_has_control_intent
        activeRunId: 'run-x', // violates paused_has_active_run
        resumeTarget: null // violates paused_without_resume_target
      }))

      const sweep = createInvariantSweep(db)
      const quarantined = sweep.sweep()

      const found = quarantined.find((q) => q.jobId === 'job-multi')
      assert.ok(found, 'job must be quarantined')
      assert.ok(found.violations.length >= 2, 'must detect multiple violations')
      const codes = found.violations.map((v) => v.code)
      assert.ok(codes.includes('job.paused_has_control_intent'))
      assert.ok(codes.includes('job.paused_has_active_run'))
      assert.ok(codes.includes('job.paused_without_resume_target'))
    })
  })
})
