import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import {
  applyCoreSchema,
  getCoreSchemaVersion,
  CORE_TABLE_STATEMENTS,
  validateCoreDb
} from '../../../src/server/adapters/sqlite/index.ts'

describe('core sqlite schema', () => {
  it('applyCoreSchema creates all core_* tables on :memory:', () => {
    const db = new Database(':memory:')
    applyCoreSchema(db)

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'core_%'
         ORDER BY name`
      )
      .all() as Array<{ name: string }>

    const names = tables.map((t) => t.name)
    for (const expected of [
      'core_artifacts',
      'core_drafts',
      'core_idempotency',
      'core_jobs',
      'core_outbox',
      'core_plan_edges',
      'core_plan_nodes',
      'core_plans',
      'core_retention_markers',
      'core_schema_meta',
      'core_task_attempts',
      'core_tasks',
      'core_threads',
      'core_verification_attempts',
      'core_workspace_leases'
    ]) {
      assert.ok(names.includes(expected), `missing table ${expected}`)
    }

    assert.equal(getCoreSchemaVersion(db), 2)
    assert.ok(CORE_TABLE_STATEMENTS.length > 0)
    assert.equal(validateCoreDb(db).ok, true)
    db.close()
  })

  it('enforces foreign keys for drafts → threads', () => {
    const db = new Database(':memory:')
    applyCoreSchema(db)
    db.pragma('foreign_keys = ON')

    assert.throws(() => {
      db.prepare(
        `INSERT INTO core_drafts(
           id, project_id, thread_id, status, revision, content, payload_json,
           created_at_ms, updated_at_ms
         ) VALUES ('d1', 'p1', 'missing-thread', 'collecting', 0, '', '{}', 1, 1)`
      ).run()
    })
    db.close()
  })

  it('enforces unique idempotency on task attempts', () => {
    const db = new Database(':memory:')
    applyCoreSchema(db)
    const now = Date.now()
    db.prepare(
      `INSERT INTO core_threads(
         id, project_id, owner_user_id, status, revision, payload_json, created_at_ms, updated_at_ms
       ) VALUES ('t1', 'p1', 'u1', 'active', 0, '{}', ?, ?)`
    ).run(now, now)
    db.prepare(
      `INSERT INTO core_jobs(
         id, project_id, thread_id, status, revision, plan_revision, execution_generation,
         payload_json, created_at_ms, updated_at_ms
       ) VALUES ('j1', 'p1', 't1', 'queued', 0, 1, 1, '{}', ?, ?)`
    ).run(now, now)
    db.prepare(
      `INSERT INTO core_tasks(
         id, project_id, job_id, status, revision, dependency_ids_json, payload_json,
         created_at_ms, updated_at_ms
       ) VALUES ('task1', 'p1', 'j1', 'pending', 0, '[]', '{}', ?, ?)`
    ).run(now, now)
    db.prepare(
      `INSERT INTO core_task_attempts(
         id, task_id, job_id, status, execution_generation, idempotency_key,
         payload_json, created_at_ms, updated_at_ms
       ) VALUES ('a1', 'task1', 'j1', 'pending', 1, 'key-1', '{}', ?, ?)`
    ).run(now, now)

    assert.throws(() => {
      db.prepare(
        `INSERT INTO core_task_attempts(
           id, task_id, job_id, status, execution_generation, idempotency_key,
           payload_json, created_at_ms, updated_at_ms
         ) VALUES ('a2', 'task1', 'j1', 'pending', 1, 'key-1', '{}', ?, ?)`
      ).run(now, now)
    })
    db.close()
  })

  it('documents no unbounded BLOB policy in schema module source', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(
      join(process.cwd(), 'src/server/adapters/sqlite/schema/core-tables.ts'),
      'utf8'
    )
    assert.match(src, /No unbounded BLOB policy/i)
    assert.match(src, /2 MiB/)
    assert.doesNotMatch(src, /CREATE TABLE[\s\S]*BLOB/i)
  })
})
