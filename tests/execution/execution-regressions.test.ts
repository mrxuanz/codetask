import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migration045ExecutionModuleTables } from '../../packages/database/src/migrations/execution.ts'
import { ExecutionOutbox } from '../../packages/server-core/src/modules/execution/events/execution-outbox.ts'
import { createStartupReconcileService } from '../../packages/server-core/src/modules/execution/recovery/application/startup.ts'
import { WorkRepository } from '../../packages/server-core/src/modules/execution/work/infrastructure/work-repository.ts'

function insertJob(db: Database.Database, id: string, state = 'running'): void {
  db.prepare(
    `INSERT INTO jobs (
      id, submission_id, submission_hash, idempotency_key, actor_id, project_id,
      source_draft_id, source_planning_session_id, title, summary, workspace_root,
      canonical_workspace_root, state, state_revision, control_intent, execution_generation,
      current_run_id, created_at, updated_at
    ) VALUES (?, ?, 'hash', ?, 'alice', 'project', 'draft', 'plan', 'Job', '', '/tmp/ws',
      '/tmp/ws', ?, 1, 'none', 1, 'run-old', 1, 1)`
  ).run(id, `submission-${id}`, `idem-${id}`, state)
}

test('work dependency rows are mapped to the domain shape', () => {
  const db = new Database(':memory:')
  migration045ExecutionModuleTables.up(db)
  db.prepare(
    `INSERT INTO job_work_dependencies (
      job_id, generation, from_work_id, depends_on_work_id, reason
    ) VALUES ('job-1', 1, 'work-b', 'work-a', 'planner')`
  ).run()

  assert.deepEqual(new WorkRepository(db).listDependencies('job-1', 1), [
    {
      jobId: 'job-1',
      generation: 1,
      fromWorkId: 'work-b',
      dependsOnWorkId: 'work-a',
      reason: 'planner'
    }
  ])
  db.close()
})

test('execution outbox maps SQLite rows before dispatch', () => {
  const db = new Database(':memory:')
  migration045ExecutionModuleTables.up(db)
  insertJob(db, 'job-outbox', 'queued')
  const received: unknown[] = []
  const outbox = new ExecutionOutbox(db, (jobId, eventType, payload, outboxId) => {
    received.push({ jobId, eventType, payload, outboxId })
  })
  outbox.enqueue('job-outbox', 'job.changed', { state: 'queued' })

  assert.equal(outbox.drainOnce(), 1)
  assert.equal(received.length, 1)
  assert.deepEqual((received[0] as { payload: unknown }).payload, { state: 'queued' })
  const row = db.prepare(`SELECT dispatched_at, attempts FROM execution_outbox`).get() as {
    dispatched_at: number | null
    attempts: number
  }
  assert.ok(row.dispatched_at)
  assert.equal(row.attempts, 0)
  db.close()
})

test('startup recovery rebuilds a claimable queue entry and clears the stale run', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migration045ExecutionModuleTables.up(db)
  insertJob(db, 'job-recover')
  db.prepare(
    `INSERT INTO execution_queue_entries (
      job_id, generation, status, priority, sequence, enqueued_at, claimed_at
    ) VALUES ('job-recover', 1, 'claimed', 0, 1, 1, 2)`
  ).run()
  db.prepare(
    `INSERT INTO execution_runs (
      id, job_id, generation, status, lease_owner, lease_expires_at, started_at, updated_at
    ) VALUES ('run-old', 'job-recover', 1, 'active', 'old-host', ?, 1, 1)`
  ).run(Date.now() + 60_000)

  createStartupReconcileService({ db }).run()

  const job = db
    .prepare(`SELECT state, current_run_id FROM jobs WHERE id = 'job-recover'`)
    .get() as {
    state: string
    current_run_id: string | null
  }
  const queue = db
    .prepare(
      `SELECT status, claimed_at, removed_at FROM execution_queue_entries WHERE job_id = 'job-recover'`
    )
    .get() as { status: string; claimed_at: number | null; removed_at: number | null }
  assert.deepEqual(job, { state: 'queued', current_run_id: null })
  assert.deepEqual(queue, { status: 'queued', claimed_at: null, removed_at: null })
  db.close()
})
