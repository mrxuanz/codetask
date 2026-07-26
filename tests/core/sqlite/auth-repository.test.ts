import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createSqliteRepositories, openKernelDatabase } from '../../../src/server/adapters/sqlite'

describe('SQLite secure authentication repository', () => {
  it('enforces one account and never accepts malformed session digests', () => {
    const database = openKernelDatabase({ filename: ':memory:' })
    const auth = createSqliteRepositories(database).auth
    try {
      auth.insertUser({
        id: 'user-1',
        username: 'Alice',
        normalizedUsername: 'alice',
        passwordHash: 'hash',
        passwordVersion: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        disabledAtMs: null
      })
      assert.throws(
        () =>
          auth.insertUser({
            id: 'user-2',
            username: 'Bob',
            normalizedUsername: 'bob',
            passwordHash: 'hash',
            passwordVersion: 1,
            createdAtMs: 1,
            updatedAtMs: 1,
            disabledAtMs: null
          }),
        /UNIQUE/
      )
      assert.throws(
        () =>
          auth.insertSession({
            id: 'session-1',
            userId: 'user-1',
            tokenDigest: 'raw-token',
            createdAtMs: 1,
            lastSeenAtMs: 1,
            expiresAtMs: 2,
            revokedAtMs: null,
            revokeReason: null
          }),
        /CHECK/
      )
    } finally {
      database.close()
    }
  })

  it('round-trips auth records, applies password CAS, and revokes excess sessions', () => {
    const database = openKernelDatabase({ filename: ':memory:' })
    const auth = createSqliteRepositories(database).auth
    try {
      auth.insertUser({
        id: 'user-1',
        username: 'Alice',
        normalizedUsername: 'alice',
        passwordHash: 'hash-1',
        passwordVersion: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        disabledAtMs: null
      })
      assert.equal(
        auth.updatePassword({
          userId: 'user-1',
          expectedVersion: 1,
          passwordHash: 'hash-2',
          updatedAtMs: 2
        }),
        true
      )
      assert.equal(
        auth.updatePassword({
          userId: 'user-1',
          expectedVersion: 1,
          passwordHash: 'stale',
          updatedAtMs: 3
        }),
        false
      )

      for (let index = 1; index <= 3; index += 1) {
        auth.insertSession({
          id: `session-${index}`,
          userId: 'user-1',
          tokenDigest: String(index).repeat(64),
          createdAtMs: index,
          lastSeenAtMs: index,
          expiresAtMs: 100,
          revokedAtMs: null,
          revokeReason: null
        })
      }
      assert.equal(auth.revokeExcessSessions('user-1', 2, 10, 'limit'), 1)
      assert.equal(auth.getSessionByDigest('1'.repeat(64))?.revokeReason, 'limit')
      assert.equal(auth.getSessionByDigest('3'.repeat(64))?.revokedAtMs, null)
    } finally {
      database.close()
    }
  })
})
