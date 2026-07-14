import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/server/db/migrations/runner'
import { allMigrations } from '../../../src/server/db/migrations/index'

function createLegacy027Db(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const through027 = allMigrations.filter((m) => m.version <= 27)
  runMigrations(db, through027)

  const now = Date.now()
  db.prepare(
    `INSERT INTO control_jobs (
      id, thread_id, project_id, draft_message_id, state, state_revision,
      control_intent, execution_generation, title, requirements_summary,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'job-legacy',
    'thread-legacy',
    'project-legacy',
    'draft-legacy',
    'execution_queued',
    1,
    'none',
    0,
    'Legacy Job',
    '',
    now,
    now
  )

  db.prepare(
    `INSERT INTO control_job_runs (
      id, job_id, kind, state, attempt_no, fence_token, execution_generation,
      pending_attempt_id, lifecycle_operation_id, started_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('run-legacy', 'job-legacy', 'execution', 'starting', 1, 'fence-legacy', 0, 'attempt-x', 'op-x', now)

  db.prepare(
    `INSERT INTO control_command_dedup (
      actor_username, idempotency_key, command_type, request_hash, response_json,
      response_revision, created_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('alice', 'key-1', 'request_pause', 'hash-1', '{"ok":true}', 2, now, now + 60_000)

  db.prepare(
    `INSERT INTO control_outbox_events (
      topic, event_type, entity_id, aggregate_revision, payload_json, payload_bytes, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('job:job-legacy', 'job.changed', 'job-legacy', 2, '{"type":"job.changed"}', 20, now)

  return db
}

describe('migration 028 corrective schema', () => {
  it('upgrades legacy 027 fixture while preserving rows', () => {
    const db = createLegacy027Db()
    runMigrations(db, allMigrations.filter((m) => m.version === 28))

    const job = db.prepare(`SELECT id FROM control_jobs WHERE id = 'job-legacy'`).get()
    assert.ok(job)

    const runColumns = (db.prepare(`PRAGMA table_info(control_job_runs)`).all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    assert.ok(!runColumns.includes('pending_attempt_id'))
    assert.ok(!runColumns.includes('lifecycle_operation_id'))

    const attemptColumns = (db.prepare(`PRAGMA table_info(control_task_attempts)`).all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    assert.ok(attemptColumns.includes('must_pause_at_commit'))

    const dedup = db
      .prepare(
        `SELECT actor_username, command_type, idempotency_key
         FROM control_command_dedup WHERE actor_username = 'alice'`
      )
      .get() as { actor_username: string; command_type: string; idempotency_key: string }
    assert.equal(dedup.command_type, 'request_pause')

    const fkCheck = db.prepare('PRAGMA foreign_key_check').all()
    assert.equal(fkCheck.length, 0)
  })

  it('fresh migrated DB passes foreign_key_check', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db, allMigrations)
    const fkCheck = db.prepare('PRAGMA foreign_key_check').all()
    assert.equal(fkCheck.length, 0)
  })
})

describe('control-plane repository time/id guard', () => {
  it('sqlite control-plane repositories do not call Date.now or randomUUID', () => {
    const root = join(process.cwd(), 'src/server/infra/sqlite/control-plane')
    const files = [
      'job-repository.ts',
      'task-repository.ts',
      'evidence-repository.ts',
      'verification-repository.ts',
      'sqlite-run-repository.ts',
      'sqlite-slot-repository.ts',
      'sqlite-outbox-repository.ts',
      'sqlite-dedup-repository.ts',
      'sqlite-runtime-repository.ts'
    ]

    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8')
      assert.match(source, /^(?!.*Date\.now).*$/s, `${file} must not call Date.now()`)
      assert.match(source, /^(?!.*randomUUID).*$/s, `${file} must not call randomUUID()`)
    }
  })
})
