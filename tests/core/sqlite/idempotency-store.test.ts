import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import {
  applyCoreSchema,
  SqliteIdempotencyStore
} from '../../../src/server/adapters/sqlite/index.ts'

describe('SqliteIdempotencyStore', () => {
  it('put/get roundtrip on :memory:', async () => {
    const db = new Database(':memory:')
    applyCoreSchema(db)
    const store = new SqliteIdempotencyStore(db)

    assert.equal(await store.get('missing'), undefined)

    await store.put('key-1', {
      payloadHash: 'hash-a',
      resultJson: JSON.stringify({ ok: true, value: 1 })
    })

    const got = await store.get('key-1')
    assert.deepEqual(got, {
      payloadHash: 'hash-a',
      resultJson: JSON.stringify({ ok: true, value: 1 })
    })

    await store.put('key-1', {
      payloadHash: 'hash-a',
      resultJson: JSON.stringify({ ok: true, value: 2 })
    })
    const updated = await store.get('key-1')
    assert.equal(updated?.resultJson, JSON.stringify({ ok: true, value: 2 }))

    db.close()
  })
})
