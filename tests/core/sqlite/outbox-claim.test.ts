import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import {
  applyCoreSchema,
  SqliteOutboxRepository,
  SqliteUnitOfWork
} from '../../../src/server/adapters/sqlite/index.ts'

describe('core outbox claim/ack', () => {
  it('claim moves pending rows and ack finalizes them', () => {
    const db = new Database(':memory:')
    applyCoreSchema(db)
    const outbox = new SqliteOutboxRepository(db)
    const now = 1_700_000_000_000

    const id1 = outbox.append({
      topic: 'job',
      eventType: 'job.updated',
      entityId: 'job-1',
      aggregateRevision: 1,
      payloadJson: '{"a":1}',
      createdAtMs: now
    })
    const id2 = outbox.append({
      topic: 'job',
      eventType: 'job.updated',
      entityId: 'job-2',
      aggregateRevision: 1,
      payloadJson: '{"a":2}',
      createdAtMs: now + 1
    })
    assert.ok(id1 > 0)
    assert.ok(id2 > id1)

    const claimed = outbox.claim({ limit: 10, claimedBy: 'worker-a', nowMs: now + 10 })
    assert.equal(claimed.length, 2)
    assert.equal(claimed[0]?.status, 'claimed')
    assert.equal(claimed[0]?.claimedBy, 'worker-a')
    assert.equal(outbox.listPending(10).length, 0)

    // Second claimer gets nothing
    const empty = outbox.claim({ limit: 10, claimedBy: 'worker-b', nowMs: now + 20 })
    assert.equal(empty.length, 0)

    outbox.ack({ ids: claimed.map((row) => row.id), ackedAtMs: now + 30 })
    const acked = db
      .prepare(`SELECT status FROM core_outbox WHERE id = ?`)
      .get(id1) as { status: string }
    assert.equal(acked.status, 'acked')
    db.close()
  })

  it('unit of work commits outbox append atomically', async () => {
    const db = new Database(':memory:')
    applyCoreSchema(db)
    const uow = new SqliteUnitOfWork(db)
    const now = Date.now()

    await uow.run(async (inner) => {
      const handle = inner as SqliteUnitOfWork
      handle.outbox.append({
        topic: 'thread',
        eventType: 'thread.updated',
        entityId: 't1',
        aggregateRevision: 1,
        payloadJson: '{}',
        createdAtMs: now
      })
    })

    assert.equal(uow.outbox.listPending(10).length, 1)

    await assert.rejects(async () => {
      await uow.run(async (inner) => {
        const handle = inner as SqliteUnitOfWork
        handle.outbox.append({
          topic: 'thread',
          eventType: 'thread.updated',
          entityId: 't2',
          aggregateRevision: 1,
          payloadJson: '{}',
          createdAtMs: now
        })
        throw new Error('boom')
      })
    })

    assert.equal(uow.outbox.listPending(10).length, 1)
    db.close()
  })
})
