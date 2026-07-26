import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertIdempotency,
  IdempotencyConflictError
} from '../../../src/server/core/application/idempotency.ts'

describe('assertIdempotency', () => {
  it('allows first use when no existing hash', () => {
    assert.doesNotThrow(() => assertIdempotency(undefined, 'hash-a', 'key-1'))
    assert.doesNotThrow(() => assertIdempotency(null, 'hash-a', 'key-1'))
    assert.doesNotThrow(() => assertIdempotency('', 'hash-a', 'key-1'))
  })

  it('allows replay when payload hash matches', () => {
    assert.doesNotThrow(() => assertIdempotency('hash-a', 'hash-a', 'key-1'))
  })

  it('throws conflict when key reused with different hash', () => {
    assert.throws(
      () => assertIdempotency('hash-a', 'hash-b', 'key-1'),
      (err: unknown) => {
        assert.ok(err instanceof IdempotencyConflictError)
        assert.equal(err.code, 'idempotency.conflict')
        assert.equal(err.key, 'key-1')
        return true
      }
    )
  })
})
