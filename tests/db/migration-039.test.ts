import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { migration039PromoteRestartInterruptedPaused } from '../../src/server/db/migrations/039_promote_restart_interrupted_paused'

function createLegacyDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE thread_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      suspension_kind TEXT,
      recovery_reason TEXT,
      last_error TEXT,
      continue_after_pause INTEGER NOT NULL DEFAULT 0,
      active_run_id TEXT
    );
    CREATE TABLE job_tasks (
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      execution_status TEXT,
      recovery_action TEXT,
      blocker_kind TEXT
    );
    CREATE TABLE workload_runs (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL
    );
    CREATE TABLE job_task_attempts (
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      run_id TEXT
    );
  `)
  return db
}

function seedPausedJob(db: Database.Database, id: string, activeRunId: string | null): void {
  db.prepare(
    `INSERT INTO thread_jobs
      (id, status, suspension_kind, recovery_reason, last_error, active_run_id)
     VALUES (?, 'paused', NULL, NULL, NULL, ?)`
  ).run(id, activeRunId)
  db.prepare(
    `INSERT INTO job_tasks
      (job_id, status, execution_status, recovery_action, blocker_kind)
     VALUES (?, 'running', 'running', NULL, NULL)`
  ).run(id)
}

test('migration 039 promotes only an owned pre-provider run and holds ambiguous rows', (t) => {
  const db = createLegacyDb()
  t.after(() => db.close())

  seedPausedJob(db, 'safe', 'run-safe')
  db.prepare(
    `INSERT INTO workload_runs (id, owner_kind, owner_id)
     VALUES ('run-safe', 'thread_job', 'safe')`
  ).run()
  db.prepare(
    `INSERT INTO job_task_attempts (job_id, status, idempotency_key, run_id)
     VALUES ('safe', 'starting', ?, 'run-safe')`
  ).run('a'.repeat(64))

  seedPausedJob(db, 'uncertain', 'run-uncertain')
  db.prepare(
    `INSERT INTO workload_runs (id, owner_kind, owner_id)
     VALUES ('run-uncertain', 'thread_job', 'uncertain')`
  ).run()
  db.prepare(
    `INSERT INTO job_task_attempts (job_id, status, idempotency_key, run_id)
     VALUES ('uncertain', 'running', ?, 'run-uncertain')`
  ).run('b'.repeat(64))

  seedPausedJob(db, 'ambiguous', null)
  migration039PromoteRestartInterruptedPaused.up(db)

  const rows = db
    .prepare(
      `SELECT id, status, suspension_kind AS suspensionKind, recovery_reason AS recoveryReason
       FROM thread_jobs ORDER BY id`
    )
    .all() as Array<{
    id: string
    status: string
    suspensionKind: string | null
    recoveryReason: string | null
  }>

  assert.deepEqual(rows, [
    {
      id: 'ambiguous',
      status: 'paused',
      suspensionKind: 'policy_hold',
      recoveryReason: 'migration_ambiguous'
    },
    { id: 'safe', status: 'pending', suspensionKind: null, recoveryReason: null },
    {
      id: 'uncertain',
      status: 'paused',
      suspensionKind: 'policy_hold',
      recoveryReason: 'uncertain_provider_outcome'
    }
  ])
})
