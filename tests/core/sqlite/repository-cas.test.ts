import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import {
  applyCoreSchema,
  SqliteJobRepository,
  SqliteThreadRepository
} from '../../../src/server/adapters/sqlite/index.ts'

function seedThread(db: Database.Database): void {
  const now = 1_700_000_000_000
  db.prepare(
    `INSERT INTO core_threads(
       id, project_id, owner_user_id, status, revision, payload_json, created_at_ms, updated_at_ms
     ) VALUES ('thread-1', 'proj-1', 'user-1', 'active', 0, '{}', ?, ?)`
  ).run(now, now)
}

describe('core repository CAS', () => {
  it('compareAndSetJob succeeds then conflicts on stale revision', () => {
    const db = new Database(':memory:')
    applyCoreSchema(db)
    seedThread(db)

    const jobs = new SqliteJobRepository(db)
    const now = 1_700_000_000_100
    jobs.save({
      id: 'job-1',
      projectId: 'proj-1',
      threadId: 'thread-1',
      planId: null,
      status: 'queued',
      revision: 0,
      planRevision: 1,
      executionGeneration: 1,
      payloadJson: '{}',
      createdAtMs: now,
      updatedAtMs: now,
      terminalAtMs: null
    })

    const ok = jobs.compareAndSet({
      id: 'job-1',
      expectedRevision: 0,
      expectedStatus: 'queued',
      next: { status: 'running', updatedAtMs: now + 1 }
    })
    assert.deepEqual(ok, { ok: true, newRevision: 1 })
    assert.equal(jobs.get('job-1')?.status, 'running')
    assert.equal(jobs.get('job-1')?.revision, 1)

    const conflict = jobs.compareAndSet({
      id: 'job-1',
      expectedRevision: 0,
      next: { status: 'paused', updatedAtMs: now + 2 }
    })
    assert.deepEqual(conflict, { ok: false, reason: 'revision_conflict' })
    assert.equal(jobs.get('job-1')?.status, 'running')
    db.close()
  })

  it('thread compareAndSet rejects stale revision', () => {
    const db = new Database(':memory:')
    applyCoreSchema(db)
    seedThread(db)
    const threads = new SqliteThreadRepository(db)
    const current = threads.get('thread-1')
    assert.ok(current)

    const conflict = threads.compareAndSet({
      id: 'thread-1',
      expectedRevision: 99,
      next: {
        projectId: current.projectId,
        ownerUserId: current.ownerUserId,
        status: current.status,
        draftId: 'draft-x',
        planId: null,
        jobId: null,
        title: current.title,
        payloadJson: '{}',
        updatedAtMs: current.updatedAtMs + 1
      }
    })
    assert.deepEqual(conflict, { ok: false, reason: 'revision_conflict' })
    db.close()
  })
})
